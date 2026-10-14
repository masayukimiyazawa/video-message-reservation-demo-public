import { parseArgs } from './seedUser.js';

describe('seedUser parseArgs (CLI 引数解釈)', () => {
  test('--id と --role を読み取る', () => {
    const result = parseArgs(['--id', 'admin', '--role', 'administrator']);

    expect(result).toEqual({
      help: false,
      force: false,
      id: 'admin',
      role: 'administrator',
      error: null,
    });
  });

  test('--force の既定は false、明示指定で true になる', () => {
    expect(parseArgs(['--id', 'admin']).force).toBe(false);
    expect(parseArgs(['--id', 'admin', '--force']).force).toBe(true);
  });

  test('--force の後に続く引数も読み取る', () => {
    const result = parseArgs(['--force', '--id', 'admin']);

    expect(result.force).toBe(true);
    expect(result.id).toBe('admin');
  });

  test('--role 省略時は undefined（呼び出し側で既定値を使う）', () => {
    const result = parseArgs(['--id', 'staff1']);

    expect(result.role).toBeUndefined();
    expect(result.id).toBe('staff1');
  });

  test('--help は usage として扱う', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  test('引数順が前後しても同じ結果になる', () => {
    expect(parseArgs(['--role', 'staff', '--id', 'a'])).toEqual(
      parseArgs(['--id', 'a', '--role', 'staff']),
    );
  });

  test('不明な引数は error を返す', () => {
    const result = parseArgs(['--id', 'admin', '--sudo']);

    expect(result.error).toContain('--sudo');
  });

  test('未知の引数が出た時点で解析を打ち切る', () => {
    const result = parseArgs(['--sudo', '--id', 'admin']);

    expect(result.id).toBeUndefined();
    expect(result.error).toContain('--sudo');
  });
});
