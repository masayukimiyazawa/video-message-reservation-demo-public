import { MIN_PASSWORD_LENGTH, validateUserInput } from './validateUserInput.js';
import { ROLES, Role } from './constants.js';

describe('domain validateUserInput (ユーザー作成入力の検証)', () => {
  test('正常な入力は ok=true と正規化済み value を返す', () => {
    const result = validateUserInput({
      userId: 'admin',
      role: Role.ADMINISTRATOR,
      password: 'correct-horse-1',
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.value).toEqual({ userId: 'admin', role: 'administrator' });
  });

  test('userId 欠落・空文字・非文字列はエラー', () => {
    for (const userId of [undefined, null, '', '   ', 123]) {
      const result = validateUserInput({
        userId,
        role: Role.STAFF,
        password: 'correct-horse-1',
      });
      expect(result.ok).toBe(false);
      expect(result.errors).toContain('userId は必須です。');
    }
  });

  test('userId の前後空白は拒否する（ログインできなくなる事故を防ぐ）', () => {
    const result = validateUserInput({
      userId: ' admin',
      role: Role.ADMINISTRATOR,
      password: 'correct-horse-1',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('userId の前後に空白を含めることはできません。');
  });

  test('userId の内部空白は拒否する', () => {
    const result = validateUserInput({
      userId: 'ad min',
      role: Role.ADMINISTRATOR,
      password: 'correct-horse-1',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('userId に空白を含めることはできません。');
  });

  test('未定義ロールは ROLES の一覧を示すメッセージで拒否する', () => {
    const result = validateUserInput({
      userId: 'admin',
      role: 'root',
      password: 'correct-horse-1',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`role は ${ROLES.join(' / ')} のいずれかです。`);
  });

  test('password 欠落・空文字はエラー', () => {
    for (const password of [undefined, null, '', 12345]) {
      const result = validateUserInput({
        userId: 'admin',
        role: Role.ADMINISTRATOR,
        password,
      });
      expect(result.ok).toBe(false);
      expect(result.errors).toContain('password は必須です。');
    }
  });

  test('password は最小文字数未満を拒否する', () => {
    const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
    const result = validateUserInput({
      userId: 'admin',
      role: Role.ADMINISTRATOR,
      password: short,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `password は ${MIN_PASSWORD_LENGTH} 文字以上で入力してください。`,
    );
  });

  test('password は trim しない（前後の空白は意図した一部として扱う）', () => {
    // 先頭・末尾に空白を含むが合計が最小文字数以上のパスワードは受理される。
    const password = ` ${'a'.repeat(MIN_PASSWORD_LENGTH)} `;
    const result = validateUserInput({ userId: 'admin', role: Role.ADMINISTRATOR, password });

    expect(result.ok).toBe(true);
  });

  test('複数の誤りはすべて列挙する（最初の1件で打ち切らない）', () => {
    const result = validateUserInput({ userId: '', role: 'root', password: 'short' });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(3);
  });

  test('入力が null でも例外を投げずに失敗を返す', () => {
    const result = validateUserInput(null);

    expect(result.ok).toBe(false);
    expect(result.value).toBeNull();
  });
});
