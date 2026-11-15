import { challengeRecord, validateDns01Record, type Dns01Challenge, type Dns01Provider, type Dns01Record } from './dns01.js';

/** Manual DNS always needs an operator; it never claims publication or deletion. */
export class ManualDns01Provider implements Dns01Provider<Dns01Record> {
  async present(challenge: Dns01Challenge): Promise<{status:'manual_action_required';record:Dns01Record}> {
    return {status:'manual_action_required',record:challengeRecord(challenge)};
  }

  async remove(record: Dns01Record): Promise<{status:'manual_action_required'}> {
    validateDns01Record(record);
    return {status:'manual_action_required'};
  }
}
