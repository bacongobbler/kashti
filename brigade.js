const { events, Job, Group } = require("brigadier");

const checkRunImage = "technosophos/brigade-github-check-run:latest"
const projectName = "kashti";

class TestJob extends Job {
  constructor(name) {
    super(name, "node:8");
    this.tasks = [
      "cd /src",
      "yarn install",
      "yarn global add @angular/cli",
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
      "yarn global add @angular/cli",
      "ng e2e"
    ];
  }
}

class ACRBuildJob extends Job {
  constructor(name, img, tag, dir, registry, sp, token, tenant) {
    super(name, "microsoft/azure-cli:latest");
    let imgName = img + ":" + tag;
    this.env = {
      AZURE_CONTAINER_REGISTRY: registry,
      ACR_SERVICE_PRINCIPAL: sp,
      ACR_TOKEN: token,
      ACR_TENANT: tenant,
    }
    this.tasks = [
      // Create a service principal and assign it proper perms on the container registry.
      `az login --service-principal -u $ACR_SERVICE_PRINCIPAL -p $ACR_TOKEN --tenant $ACR_TENANT`,
      `cd ${dir}`,
      `echo '========> building ${imgName}...'`,
      `az acr build -r $AZURE_CONTAINER_REGISTRY -t ${imgName} .`,
      `echo '<======== finished building ${imgName}.'`
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
    var releaser = new ACRBuildJob(`${projectName}-release`, projectName, tag, "/src", project.secrets.acrName, project.secrets.acrServicePrincipalName, project.secrets.acrServicePrincipalToken, project.secrets.acrServicePrincipalTenant);
    var latestReleaser = new ACRBuildJob(`${projectName}-release-latest`, projectName, "latest", "/src", project.secrets.acrName, project.secrets.acrServicePrincipalName, project.secrets.acrServicePrincipalToken, project.secrets.acrServicePrincipalTenant);
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
  const gh = JSON.parse(e.payload);
  // Common configuration
  const env = {
    CHECK_PAYLOAD: e.payload,
    CHECK_NAME: "Chart Tester",
  }

  var tester = new TestJob(`${projectName}-test`)
  var releaser = new ACRBuildJob(`${projectName}-test-release`, projectName, `git-${gh.body.check_suite.head_sha.substring(0, 7)}`, "/src", p.secrets.acrName, p.secrets.acrServicePrincipalName, p.secrets.acrServicePrincipalToken, p.secrets.acrServicePrincipalTenant);

  // For convenience, we'll create three jobs: one for each GitHub Check
  // stage.
  const startTester = new Job("start-test-run", checkRunImage)
  startTester.env = env
  startTester.env.CHECK_TITLE = "Unit tests"
  startTester.env.CHECK_SUMMARY = "Beginning test run"

  const endTester = new Job("end-test-run", checkRunImage)
  endTester.env = env
  endTester.env.CHECK_TITLE = startTester.env.CHECK_TITLE

  const startReleaser = new Job("start-release-run", checkRunImage)
  startReleaser.env = env
  startReleaser.env.CHECK_TITLE = "Docker image tests"
  startReleaser.env.CHECK_SUMMARY = "Beginning test run"

  const endRelease = new Job("end-release-run", checkRunImage)
  endRelease.env = env
  endRelease.env.CHECK_TITLE = startTester.env.CHECK_TITLE

  Group.runEach([startTester, tester])
    .then((result) => {
      endTester.env.CHECK_CONCLUSION = "success"
      endTester.env.CHECK_SUMMARY = "Build completed"
      endTester.env.CHECK_TEXT = result.toString()
      endTester.run()
    })
    .catch((err) => {
      // In this case, we mark the ending failed.
      endTester.env.CHECK_CONCLUSION = "failure"
      endTester.env.CHECK_SUMMARY = "Build failed"
      endTester.env.CHECK_TEXT = `${err}`
      endTester.run()
    })

  Group.runEach([startReleaser, releaser])
    .then((result) => {
      endReleaser.env.CHECK_CONCLUSION = "success"
      endReleaser.env.CHECK_SUMMARY = "Build completed"
      endReleaser.env.CHECK_TEXT = result.toString()
      endReleaser.run()
    })
    .catch((err) => {
      // In this case, we mark the ending failed.
      endReleaser.env.CHECK_CONCLUSION = "failure"
      endReleaser.env.CHECK_SUMMARY = "Build failed"
      endReleaser.env.CHECK_TEXT = `${err}`
      endReleaser.run()
    })
}

events.on("exec", test);
events.on("check_suite:requested", checkRequested);
events.on("check_suite:rerequested", checkRequested);
events.on("check_run:rerequested", checkRequested);
console.log('hit me baby one more time')
