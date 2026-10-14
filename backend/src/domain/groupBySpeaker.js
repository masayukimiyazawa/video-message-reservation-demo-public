/**
 * 文字起こし整形ドメインロジック (要件 8.3 / Property 10)
 *
 * Vonage Post-Call Transcription の生 JSON を、発話セグメントを
 * 話者（ストリーム）単位に対応付けた形式へ整形する純粋関数。
 *
 * 設計上の前提（design: 設計上の重要な前提）:
 * - 話者分離は `segments[].channel`（整数）で表現される。
 * - `channels_metadata` の各要素の `id` がストリーム ID に対応し、
 *   channel はその配列インデックス（または要素の `channel` 値）で解決する。
 *
 * Vonage 実データとの整合（2026-09-25 実測・individual archive / ja-JP）:
 *   Vonage が返す生 JSON の **実際の形** は次のとおりであり、当初想定と 3 点ずれていた。
 *     1. セグメントはトップレベルではなく `transcription.segments` にある。
 *        → トップレベル `segments` を読むと常に空になり、話者分離が無言で空の結果になる。
 *     2. `channels_metadata` は **配列ではなく**、channel 番号をキーにしたオブジェクト
 *        （`{"0": {...}, "1": {...}}`）である。
 *        → 配列前提だとメタデータ表が空になり、stream ID が一切解決されない。
 *     3. `speaker_display_name` は `{"role":"guest","displayName":"Guest"}` の
 *        **二重 JSON エンコード文字列**である（JSON オブジェクトの文字列表現）。
 *        → そのまま表示すると生 JSON が画面に出る。
 *   実データで検証済み。上記を吸収するため、入力は実構造を優先しトップレベル/配列形式も
 *   後方互換として受け付ける。出力はどちらの入力形式でも同一形となる。
 *
 * 副作用を持たない純粋関数であり、引数を変更せず外部状態にも依存しない。
 * 元 JSON の全セグメントを過不足なく保存し（欠落・重複なし）、
 * 各セグメントは channels_metadata で解決可能な話者へ対応付ける。
 *
 * @typedef {import('./types.js').SpeakerTranscript} SpeakerTranscript
 */

/**
 * `channels_metadata` を「channel 番号 → メタデータ」のリストへ正規化する。
 *
 * Vonage 実データは `{"0": {...}, "1": {...}}` という**オブジェクト**であり、
 * 想定していた配列ではない。キー（channel 番号）を明示的な `channel` 値へ移し、
 * 配列と同一の内部表現に寄せる。どちらの形式でも後続の処理は変わらない。
 *
 * @param {Array<Object>|Object<string,Object>|undefined} channelsMetadata
 * @returns {Array<Object>} 配列形式に正規化したメタデータ
 */
function toMetadataList(channelsMetadata) {
  if (Array.isArray(channelsMetadata)) {
    return channelsMetadata;
  }
  if (channelsMetadata == null || typeof channelsMetadata !== 'object') {
    return [];
  }
  return Object.entries(channelsMetadata)
    .filter(([, meta]) => meta != null && typeof meta === 'object')
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([key, meta]) => (typeof meta.channel === 'number' ? meta : { ...meta, channel: Number(key) }));
}

/**
 * 発話セグメント配列を解決する。
 *
 * Vonage 実データは `transcription.segments` に配置される。トップレベルの `segments`
 * （当初想定）は後方互換として受け付ける。
 *
 * @param {Object} source
 * @returns {Array<Object>}
 */
function resolveSegments(source) {
  if (Array.isArray(source.transcription?.segments)) {
    return source.transcription.segments;
  }
  if (Array.isArray(source.segments)) {
    return source.segments;
  }
  return [];
}

/**
 * channels_metadata から channel 番号 → メタデータ の対応表を構築する。
 *
 * Vonage の Post-Call Transcription では channels_metadata は channel をキーにした
 * オブジェクトで提供される（配列ではない）。channel との対応は次の優先順で解決する:
 *   1. 要素が明示的な `channel` 数値を持つ場合はその値をキーにする。
 *   2. それ以外はオブジェクトのキー（channel 番号）を用いる。
 *   3. 配列が渡された場合は後方互換として配列インデックスを channel 番号とみなす。
 *
 * @param {Array<Object>|Object<string,Object>} channelsMetadata
 * @returns {Map<number, {streamId: string, speakerLabel: string}>}
 */
function buildChannelMetadataMap(channelsMetadata) {
  const map = new Map();

  toMetadataList(channelsMetadata).forEach((meta, index) => {
    if (meta == null) {
      return;
    }

    const channel = Number.isFinite(Number(meta.channel)) ? Number(meta.channel) : index;
    const streamId = meta.id != null ? String(meta.id) : '';
    // 表示名は明示ラベルがあれば優先し、なければ stream ID をラベルとして用いる。
    const speakerLabel = resolveSpeakerLabel(meta, streamId);

    map.set(channel, { streamId, speakerLabel });
  });

  return map;
}

/**
 * `speaker_display_name` から表示名を抽出する。
 *
 * Vonage 実データでは `{"role":"guest","displayName":"Guest"}` という
 * **二重 JSON エンコード文字列**になっている。復号できる場合は表示名を返す。
 *
 * @param {string} raw
 * @returns {string|undefined} 表示名。抽出できない場合は undefined
 */
function extractDisplayName(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed != null && typeof parsed === 'object') {
      for (const key of ['displayName', 'display_name', 'name']) {
        if (typeof parsed[key] === 'string' && parsed[key].length > 0) {
          return parsed[key];
        }
      }
    }
  } catch {
    // JSON として解釈できなければ「表示名なし」として扱い、stream ID へフォールバックする。
  }
  return undefined;
}

/**
 * channels_metadata の要素から話者表示名を解決する。
 * 明示的な name / label があればそれを、なければ stream ID を用いる。
 *
 * @param {Object} meta
 * @param {string} streamId
 * @returns {string}
 */
function resolveSpeakerLabel(meta, streamId) {
  const candidates = [
    meta.speakerLabel,
    meta.name,
    meta.label,
    extractDisplayName(meta.speaker_display_name),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return streamId;
}

/**
 * 生セグメントを整形後セグメント（{ start, end, text }）へ正規化する。
 * @param {Object} segment
 * @returns {{start: number, end: number, text: string}}
 */
function normalizeSegment(segment) {
  return {
    start: segment.start,
    end: segment.end,
    text: segment.text,
  };
}

/**
 * 文字起こし整形 (要件 8.3 / Property 10)
 *
 * Post-Call Transcription の生 JSON から、話者（channel / stream）単位に
 * まとめた SpeakerTranscript の配列を返す純粋関数。
 *
 * - 入力 `segments`（実データでは `transcription.segments`）の全要素を過不足なく出力へ含める。
 * - 各セグメントは `channel` を通じて `channels_metadata`（id = stream ID）で
 *   解決される話者に対応付ける。
 * - channels_metadata に対応がない channel は、streamId を空文字とした
 *   話者エントリへまとめ、セグメントの取りこぼしを防ぐ。
 * - 出力順は最初にその channel のセグメントが現れた順を保持する。
 *
 * @param {Object} rawJson - Post-Call Transcription の生 JSON（Vonage 実構造）
 * @param {Array<Object>} [rawJson.transcription.segments] - 発話セグメント配列（Vonage 実形式）
 * @param {Array<Object>} [rawJson.segments] - 発話セグメント配列（後方互換）
 * @param {Object<string,Object>|Array<Object>} [rawJson.channels_metadata] - チャンネル（ストリーム）メタデータ
 * @returns {SpeakerTranscript[]} 話者単位に整形した文字起こし
 */
export function groupBySpeaker(rawJson) {
  const source = rawJson || {};
  const segments = resolveSegments(source);
  const metadataMap = buildChannelMetadataMap(source.channels_metadata);

  // channel 番号 → SpeakerTranscript の対応表。出現順を保つため Map を用いる。
  const groups = new Map();

  for (const segment of segments) {
    if (segment == null) {
      continue;
    }

    const channel = typeof segment.channel === 'number' ? segment.channel : -1;

    if (!groups.has(channel)) {
      const meta = metadataMap.get(channel);
      groups.set(channel, {
        channel,
        streamId: meta ? meta.streamId : '',
        speakerLabel: meta ? meta.speakerLabel : '',
        segments: [],
      });
    }

    groups.get(channel).segments.push(normalizeSegment(segment));
  }

  return Array.from(groups.values());
}
