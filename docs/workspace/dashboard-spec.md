> 公開版：非公開 repo（bot-workspace）の運用文書の複製です。公開にあたり固有名・現況の一部を調整しています。正は原本側にあります。

# ダッシュボード仕様: Bot オフィス（three.js）

目的: bot-workspace の活動（誰が・何を・どの状態か）を、3D オフィス風の画面で一目で分かるようにする。
見た目の楽しさが目的ではなく、「ボードと状態ファイルを見に行かなくても、異常と判断待ちが目に入る」ことが目的。

## 1. データ契約（ここが本体）

可視化より先に、状態の持ち方を固定する。Markdown の表は人間用に残し、機械可読な状態を別に持つ。

- `state/bots.json`: Bot ごとの現在状態。Bot は自分の行だけを更新する。

```json
{
  "updated_at": "2026-11-02T20:30:00+09:00",
  "bots": [
    {
      "id": "muse",
      "name": "Muse",
      "role": "調整・検証",
      "state": "working",        
      "current_request": "REQ-001",
      "current_task": "ダッシュボード仕様の検証",
      "last_event": "2026-11-02T20:25:00+09:00",
      "note": ""
    }
  ]
}
```

- `state` の値: `idle`（待機）/ `working`（作業中）/ `waiting`（他者待ち）/ `review`（検証中、主に Muse）/
  `blocked`（停止・申告あり）/ `approval`（みずまわり の判断待ち）
- `state/requests.json`: 依頼の一覧（id、件名、担当、状態、最終更新）。BOARD.md と二重管理にならないよう、
  こちらを正とし、BOARD.md は当面の人間用ミラーとする（将来は requests.json から生成）。
- 更新責任: 各 Bot は着手・完了・停止のたびに自分の状態を更新する。更新をサボると画面で「古いまま」と分かる
  （last_event からの経過で色が褪せる）のが、このダッシュボードの実質的な機能。
- 契約の検査は `tools/check_state.py` で行う（必須キー、state の値、時刻形式、参照整合）。

### REQ-001 実装で追加された任意項目（2026-11-02、Muse が採用を決定）

- bots.json の任意項目: `group`（所属ゾーン）、`registered`（false = 準備中の空席）、`last_output`（直近の成果物）、
  `usage`（利用量の申告。枯渇・警告を書く）
- requests.json: 各依頼は `requester` / `next_action` / `request_file` / `result_file` を持つ。
  `state` の値は `open` / `working` / `review` / `approval` / `done` / `blocked`。
- これらは任意項目としてデータ契約に含める。必須キーと Bot の state 6値は従来どおり。

### 画面が依存する最低集合と鮮度の表し方（REQ-003 提案）

- 受け入れに必要な最低集合: bots.json は必須 8 キー（`id` `name` `role` `state` `current_request` `current_task`
  `last_event` `note`）に `registered` を加えたもの（空席の表現に要る。省略時は登録済みとして扱う）。
  requests.json は必須 5 キー（`id` `title` `assignee` `state` `updated_at`）に `result_file` を加えたもの
  （inbox/ の件数をここから数えるため）。`group` `last_output` `usage` `requester` `next_action` `request_file` は
  無くても表示は壊れない（色・詳細・警告・キューの補足が減るだけ）。
- `last_event` は分からなければ `null`（推測で埋めない）。画面では「記録なし」として、色褪せ（古い）とは別の印
  （ランプの灰色の輪、点線の名札）で示す。鮮度の段階: 6 時間未満は鮮明、6〜24 時間でやや褪せる、24 時間以上で大きく褪せる。
- 検査: `tools/check_state.py` は契約違反を NG、BOARD.md・依頼ファイルの frontmatter・着手ロックとのずれを「注意」として出す。
  どちらを正とするかは判断しない（requests.json を正とする原則は本節冒頭のとおり）。
- テスト用の状態は `state/testdata/<名前>/` に置き、本番の `state/*.json` と混ぜない。

## 2. 画面（v1 の範囲）

- three.js のアイソメトリックな小さなオフィス。Bot ごとにデスクとアバター（簡素なローポリ／色分けで十分）。
  - Muse: 中央の調整デスク
  - 管理＋Grok 配下4体（テスト、ゲーム開発アシスタント、各種データまとめ、トレード担当）: 窓側の一角
  - Claude 群: 実装デスク列
  - Gemini Spark（検証担当）: 独立した一角のデスク
- 状態の表現: 頭上のランプ色＋アニメーション（working=タイピング/歩行、idle=待機、blocked=赤点滅、approval=みずまわり 席への吹き出し）。
  みずまわり の席も置き、「判断待ち」が溜まっているのが見えるようにする。
- クリックで詳細パネル: その Bot の現在タスク、直近の成果物、last_event。
- サイドパネル（2D でよい）: 依頼キュー（requests/ と inbox/ の件数と中身）、承認ゲート待ち一覧、利用量の警告（STATUS の申告）。
- まずは読み取り専用。操作（承認ボタン等）は v1 では入れない（みずまわり の操作は従来どおりチャット/ repo で）。

## 3. 技術

- 配置: この repo の `dashboard/` フォルダ。three.js は CDN（cdnjs）+ ES Modules（importmap）、ビルド工程なしで
  GitHub Pages 相当の静的配信でもローカルでも開ける形を v1 の目標にする。
- 状態の読み込み: `state/*.json` を fetch。private repo のため、配信方法は実装時に決める
  （ローカルで開く／Muse の VM から配信／公開用に状態だけ別途出す、のいずれか。認証情報を画面側に埋め込まない）。
- 描画負荷: ドローコールとポリゴン数は控えめに（他の描画検証の知見: 数千プリミティブで十分成立する）。

## 4. 分担

- 実装: Claude 群（この仕様とデータ契約に沿って dashboard/ を実装）
- 意匠レビュー: Grok（LOOKS の最終確認は Grok の物差し — ori の分担と同じ）
- 仕様・データ契約・受け入れ検証: Muse
- 判断: みずまわり（公開方法と、v2 以降の範囲）

## 5. 受け入れ基準（v1）

1. state/bots.json のダミーではなく実データで、全 Bot のデスクと状態ランプが表示される。
2. bots.json の state を変えると、再読み込みで画面の表現が変わる（working / blocked / approval の3種は必須）。
3. 詳細パネルとサイドパネル（依頼キュー・承認待ち）が表示される。
4. 通常のノート PC のブラウザで重くないこと（目安: 30fps 以上、描画コール 100 未満）。

## 6. v2 以降（今はやらない）

- GitHub の更新に合わせた自動リフレッシュ、履歴の再生（タイムライン）
- 画面からの承認操作（みずまわり のみ、認証つき）
- Bot の移動アニメーションや会議室（依頼の受け渡しを可視化）
