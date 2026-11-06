import { describe, expect, it } from 'vitest';
import { classifyEnvReport, prepareSessionEnv } from './session-env';

describe('prepareSessionEnv', () => {
  it('returns nothing to send when no variables are requested', () => {
    expect(prepareSessionEnv(undefined)).toBeUndefined();
    expect(prepareSessionEnv({})).toBeUndefined();
  });

  it('returns a copy of a valid environment', () => {
    const env = { LANG: 'C.UTF-8', APP_ENV: 'staging' };
    const prepared = prepareSessionEnv(env);
    expect(prepared).toEqual(env);
    expect(prepared).not.toBe(env);
  });

  it('throws invalid_env naming every problem, the code the gateway uses', () => {
    expect(() => prepareSessionEnv({ '1BAD': 'x', OK_NAME: 'a\u0000b' })).toThrow(
      /^invalid_env: .*1BAD.*OK_NAME contains a NUL/
    );
  });
});

describe('classifyEnvReport', () => {
  it('splits the requested names into accepted, rejected and not reported', () => {
    expect(
      classifyEnvReport(
        { LANG: 'C', APP_ENV: 'x', TZ: 'UTC' },
        { envAccepted: ['LANG'], envRejected: ['APP_ENV'] }
      )
    ).toEqual({ accepted: ['LANG'], rejected: ['APP_ENV'], notReported: ['TZ'] });
  });

  it('marks every name not reported when the server sent no verdict', () => {
    const none = { accepted: [], rejected: [], notReported: ['LANG'] };
    expect(classifyEnvReport({ LANG: 'C' }, null)).toEqual(none);
    expect(classifyEnvReport({ LANG: 'C' }, {})).toEqual(none);
  });

  it('ignores names in the verdict that were never requested', () => {
    expect(
      classifyEnvReport({ LANG: 'C' }, { envAccepted: ['LANG', 'PATH'], envRejected: ['EXTRA'] })
    ).toEqual({ accepted: ['LANG'], rejected: [], notReported: [] });
    expect(classifyEnvReport(undefined, { envAccepted: ['LANG'] })).toEqual({
      accepted: [],
      rejected: [],
      notReported: []
    });
  });
});
