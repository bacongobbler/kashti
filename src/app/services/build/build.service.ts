import { Observable } from 'rxjs/Observable';
import { Build } from '../../models/build';

export abstract class BuildService {
    abstract getBuilds(projectId: string): Observable<Build[]>;
    abstract getBuild(buildId: string): Observable<Build>;
    abstract getBuildLog(buildId: string): Observable<string>;
}
