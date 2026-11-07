import { describe, it, expect, beforeEach } from 'vitest';
import { recordDiagnostic, listDiagnostics, clearDiagnostics, diagnosticsSummary } from './diagnostics.js';

describe('diagnostics', () => {
  beforeEach(() => clearDiagnostics());
  it('caps ring buffer and summarizes', () => {
    for (let i = 0; i < 250; i++) recordDiagnostic('ERR_TEST', `m${i}`);
    expect(listDiagnostics().length).toBe(200);
    expect(diagnosticsSummary().total).toBe(200);
    expect(diagnosticsSummary().byCode.ERR_TEST).toBe(200);
  });
  it('truncates long messages', () => {
    recordDiagnostic('X', 'a'.repeat(1000));
    expect(listDiagnostics()[0]!.message.length).toBeLessThanOrEqual(500);
  });
});
