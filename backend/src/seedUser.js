/**
 * ユーザー作成 CLI（管理者/スタッフの初回投入）
 *
 * 使い方:
 *   USER_SEED_PASSWORD='<12文字以上>' npm run seed:user -- --id admin --role administrator
 *
 * 設計方針:
 *  - パスワードは CLI 引数で受け取らない。引数はシェルの履歴や
 *    `ps` の出力に残るため、環境変数 (USER_SEED_PASSWORD) でのみ受ける。
 *  - 実際のハッシュ化と重複判定は services/userService.js に委譲する。
 *    このファイルは引数解釈・DB 接続・結果表示だけを責務とする。
 *  - 出力に平文・passwordHash は一切含めない。
 *
 * 実行方法:
 *   node src/seedUser.js --id admin --role administrator
 *   node src/seedUser.js --help
 */

import { Role, ROLES } from './domain/constants.js';
import { MIN_PASSWORD_LENGTH } from './domain/validateUserInput.js';
import { connectToDatabase, disconnectFromDatabase } from './infra/mongoConnection.js';
import { UserCreationError, createUserService } from './services/userService.js';

/** パスワードを受け取る環境変数名。 */
const PASSWORD_ENV_KEY = 'USER_SEED_PASSWORD';

const USAGE = `使い方:
  USER_SEED_PASSWORD='<${MIN_PASSWORD_LENGTH}文字以上>' npm run seed:user -- --id <userId> --role <role>
  USER_SEED_PASSWORD='<${MIN_PASSWORD_LENGTH}文字以上>' npm run seed:user -- --id <userId> --force

引数:
  --id <userId>    ログイン ID（空白なし・一意）
  --role <role>    ${ROLES.join(' | ')}（既定: ${Role.ADMINISTRATOR}）
  --force          既存 userId なら passwordHash を上書きする（ロールは変更しない）
  --help           この表示

環境変数:
  ${PASSWORD_ENV_KEY}   平文パスワード（必須・${MIN_PASSWORD_LENGTH}文字以上）
`;

/**
 * コマンドライン引数を解析する。
 *
 * @param {string[]} argv `process.argv.slice(2)` 相当
 * @returns {{ help: boolean, force: boolean, id: string|undefined, role: string|undefined, error: string|null }}
 */
export function parseArgs(argv) {
  const result = { help: false, force: false, id: undefined, role: undefined, error: null };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--force') {
      result.force = true;
    } else if (arg === '--id') {
      result.id = argv[i + 1];
      i += 1;
    } else if (arg === '--role') {
      result.role = argv[i + 1];
      i += 1;
    } else {
      result.error = `不明な引数: ${arg}`;
      return result;
    }
  }

  return result;
}

/**
 * 引数と環境変数からユーザー作成を実行する（副作用を伴うため CLI からしか呼ばない）。
 *
 * @param {string[]} [argv]
 * @returns {Promise<number>} プロセス終了コード（0 成功 / 1 失敗）
 */
export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) {
    // eslint-disable-next-line no-console
    console.log(USAGE);
    return 0;
  }
  if (args.error) {
    // eslint-disable-next-line no-console
    console.error(`[seed] ${args.error}\n\n${USAGE}`);
    return 1;
  }
  if (!args.id) {
    // eslint-disable-next-line no-console
    console.error(`[seed] --id が必須です。\n\n${USAGE}`);
    return 1;
  }
  if (!process.env[PASSWORD_ENV_KEY]) {
    // eslint-disable-next-line no-console
    console.error(
      `[seed] 環境変数 ${PASSWORD_ENV_KEY} が未設定です。` +
        ' パスワードを引数で渡すとシェル履歴に残るため、環境変数で渡してください。',
    );
    return 1;
  }

  const password = process.env[PASSWORD_ENV_KEY];
  // プロセス内で平文が生き続けないよう、実行後に必ず消す。
  delete process.env[PASSWORD_ENV_KEY];

  await connectToDatabase();

  try {
    if (args.force) {
      // 平文が失われた管理者の復旧経路。ロールは変更せず passwordHash だけ差し替える。
      const { setUserPassword } = createUserService();
      const result = await setUserPassword({ userId: args.id, password });
      // eslint-disable-next-line no-console
      console.log(
        result.created
          ? `[seed] --force: ユーザーは存在しなかったため新規作成しました: userId=${result.user.userId} role=${result.user.role}`
          : `[seed] --force: 既存ユーザーのパスワードを再設定しました: userId=${result.user.userId} role=${result.user.role}`,
      );
      return 0;
    }

    const { createUser } = createUserService();
    const created = await createUser({
      userId: args.id,
      role: args.role ?? Role.ADMINISTRATOR,
      password,
    });
    // eslint-disable-next-line no-console
    console.log(`[seed] ユーザーを作成しました: userId=${created.userId} role=${created.role}`);
    return 0;
  } catch (err) {
    if (err instanceof UserCreationError) {
      // eslint-disable-next-line no-console
      console.error(`[seed] 作成に失敗しました (${err.code}): ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    await disconnectFromDatabase();
  }
}

// 直接起動された場合のみ実行する（テスト時の副作用回避）
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[seed] 予期しないエラー:', err);
      process.exitCode = 1;
    });
}
