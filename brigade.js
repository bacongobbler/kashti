const { events, Job, Group } = require("brigadier");

const checkRunImage = "technosophos/brigade-github-check-run:latest"
const projectName = "kashti";

class TestJob extends Job {
  constructor(name) {
    super(name, "node:8");
    this.tasks = [
      "cd /src",
      "yarn install",
      "ng lint",
      "ng test --single-run",
    ];
  }
}

class E2eJob extends Job {
  constructor(name) {
    super(name, "node:8");
    this.tasks = [
      "cd /src",
      "yarn install",
      "ng e2e"
    ];
  }
}

class ACRBuildJob extends Job {
  constructor(name, img, tag, dir, registry, token, tenant) {
    super(name, "microsoft/azure-cli:latest");
    let imgName = img + ":" + tag;
    this.env = {
      AZURE_CONTAINER_REGISTRY: registry,
      ACR_TOKEN: token,
      ACR_TENANT: tenant,
    }
    this.tasks = [
      // Create a service principal and assign it proper perms on the container registry.
      `az login --service-principal -u $AZURE_CONTAINER_REGISTRY -p $ACR_TOKEN --tenant $ACR_TENANT`,
      `cd ${dir}`,
      `echo '========> building ${img}...'`,
      `az acr build -r ${registry} -t ${imgName} .`,
      `echo '<======== finished building ${img}.'`
    ];
  }
}

function ghNotify(state, msg, e, project) {
  const gh = new Job(`notify-${state}`, "technosophos/github-notify:latest");
  gh.env = {
    GH_REPO: project.repo.name,
    GH_STATE: state,
    GH_DESCRIPTION: msg,
    GH_CONTEXT: "brigade",
    GH_TOKEN: project.secrets.ghToken,
    GH_COMMIT: e.revision.commit
  }
  return gh
}

events.on("push", (e, project) => {
  const gh = JSON.parse(e.payload);
  const start = ghNotify("pending", `build started as ${e.buildID}`, e, project)
  if (gh.ref.startsWith("refs/tags/") || gh.ref == "refs/heads/master") {
    let parts = gh.ref.split("/", 3);
    let tag = parts[2];
    var releaser = new ACRBuildJob(`${projectName}-release`, projectName, tag, "/src", project.secrets.acrName, project.secrets.acrToken, project.secrets.acrTenant);
    var latestReleaser = new ACRBuildJob(`${projectName}-release-latest`, projectName, "latest", "/src", project.secrets.acrName, project.secrets.acrToken, project.secrets.acrTenant);
    Group.runAll([start, releaser, latestReleaser])
      .catch(err => {
        return ghNotify("failure", `failed build ${e.buildID}`, e, project).run()
      });
  } else {
    console.log('not a tag or a push to master; skipping')
  }
  return ghNotify("success", `build ${e.buildID} passed`, e, project).run()
});

function test() {
  const test = new TestJob(`${projectName}-test`)
  const e2e = new E2eJob(`${projectName}-e2e`)
  return Group.runAll([test, e2e]);
}

function checkRequested(e, p) {
  console.log("check requested")
  console.log(e.payload)
  // Common configuration
  const env = {
    CHECK_PAYLOAD: e.payload,
    CHECK_NAME: "Chart Tester",
    CHECK_TITLE: "Lint all Helm Charts",
  }

  var tester = new TestJob(`${projectName}-test`)
  var releaser = new ACRBuildJob(`${projectName}-test-release`, projectName, tag, "/src", project.secrets.acrName, project.secrets.acrToken, project.secrets.acrTenant);

  // For convenience, we'll create three jobs: one for each GitHub Check
  // stage.
  const start = new Job("start-run", checkRunImage)
  start.imageForcePull = true
  start.env = env
  start.env.CHECK_SUMMARY = "Beginning test run"

  const end = new Job("end-run", checkRunImage)
  end.imageForcePull = true
  end.env = env

  // Now we run the jobs in order:
  // - Notify GitHub of start
  // - Run the test
  // - Notify GitHub of completion
  //
  // On error, we catch the error and notify GitHub of a failure.
  start.run().then(() => {
    return tester.run()
  }).then((result) => {
    end.env.CHECK_CONCLUSION = "success"
    end.env.CHECK_SUMMARY = "Build completed"
    end.env.CHECK_TEXT = result.toString()
    return end.run()
  }).catch((err) => {
    // In this case, we mark the ending failed.
    end.env.CHECK_CONCLUSION = "failed"
    end.env.CHECK_SUMMARY = "Build failed"
    end.env.CHECK_TEXT = `Error: ${err}`
    return end.run()
  })
}

events.on("exec", test);

events.on("check_suite:requested", checkRequested);
events.on("check_suite:rerequested", checkRequested);
events.on("check_run:rerequested", checkRequested);
console.log('hi!')
