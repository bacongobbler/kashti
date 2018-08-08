import { Observable } from 'rxjs/Observable';

export abstract class LogService {
  abstract getLog(jobId: string): Observable<string>;
}
