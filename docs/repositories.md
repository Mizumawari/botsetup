# 関連リポジトリの内容

Bot 協調運用で使っているリポジトリの一覧と、それぞれの中身です。役割ごとに repo を分け、「どこに何の正があるか」を固定するのが要点です。

## botsetup（この repo・公開）

運用ノウハウの公開まとめ。

```text
README.md                  … 全体像
docs/shared-brain.md       … 共有ブレインの設計
docs/research-playbook.md  … Muse×Grok リサーチ活用術20選の要約と適用状況
docs/search.md             … 検索基盤の使い分け
docs/repositories.md       … このファイル
```

## bot-workspace（非公開）— 調整と台帳

Bot 群の仕事の受け渡しと状態管理の正。方針とルールはここの文書が正で、他の repo は複写しない。

```text
README.md / REGISTRY.md    … 参加者（人と Bot）の登録簿
RULES.md / PROTOCOL.md     … 方針・承認ゲート・受け渡しの手順（正）
BOARD.md / STATUS.md       … 人間向けの一覧（機械可読な台帳に従属）
requests/                  … 依頼ファイル（REQ-*）
inbox/                     … Bot からの返却（RES-*）
outbox/                    … 検証済みの返却
state/                     … 機械可読な台帳（bots.json / requests.json、利用量ログ）
dashboard/                 … 状態を可視化するダッシュボード
tools/                     … 台帳の整合チェック、依頼の claim 手続き
docs/                      … 管理体制、自律運用、ダッシュボード仕様、承認センター、判定レイヤー
```

運用の要点：

- 受け渡しは非同期・ファイル経由。依頼 → 返却 → 検証して outbox へ
- 台帳（JSON）が正で、一覧表はそれに合わせる。ずれはチェックスクリプトが検出する
- 定期巡回が差分を見て、検証・集約・ダッシュボードへの同期を行う

公開できる文書は、この repo に複製を収録しています（[docs/workspace/](workspace/)）：

- [rules.md](workspace/rules.md)：全員共通の規則（承認ゲート、検証の独立性、停止条件）
- [protocol.md](workspace/protocol.md)：連携プロトコル（受け渡しの流れ、claim 手続き）
- [autonomy.md](workspace/autonomy.md)：自律協調の設計（トリガーと巡回）
- [approval-center.md](workspace/approval-center.md)：承認センターの設計
- [decision-gate.md](workspace/decision-gate.md)：判定レイヤーの設計（型と判定カタログ）
- [management.md](workspace/management.md)：管理体制
- [dashboard-spec.md](workspace/dashboard-spec.md)：ダッシュボード仕様（データ契約）

## secondbrain（非公開）— 共有ブレイン

全 Bot が共有する知識置き場。設計は [shared-brain.md](shared-brain.md)。

```text
BRAIN.md          … 地図（目次、100行以内）
projects/         … プロジェクトごとの状態と次の一手（now.md が現在地）
people/           … 人と Bot のカード
notes/            … トピックごとの事実
decisions.md      … 決定の記録
diary/            … Bot ごとの日記
playbooks/        … 手順書
.claude/rules/    … フォルダごとの書き方ルール
scripts/          … 機械チェック（行数・ファイル名・秘密情報・リンク切れ）＋ CI
```

公開できる文書は、この repo に複製を収録しています（[docs/brain/](brain/)）：

- [second-brain-design.md](brain/second-brain-design.md)：4層設計の根拠（元記事の指摘と対策）
- playbooks（[brain-write](brain/playbooks/brain-write.md) / [diary-promotion](brain/playbooks/diary-promotion.md) / [weekly-review](brain/playbooks/weekly-review.md) / [res-verification](brain/playbooks/res-verification.md) / [decision-gate](brain/playbooks/decision-gate.md)）：書き込み、日記の昇格、週次見直し、返却の検証、判定の使い方
- rules（[dashboard](brain/rules/dashboard.md) / [decisions](brain/rules/decisions.md) / [diary](brain/rules/diary.md) / [notes](brain/rules/notes.md) / [people](brain/rules/people.md) / [playbooks](brain/rules/playbooks.md) / [projects](brain/rules/projects.md)）：フォルダごとの書き方ルール

収録していないもの：運用データそのもの（台帳・依頼・返却・日記・利用量）、個人やプロジェクトのカード、環境固有の運用メモ（配信ホスティング等）。これらは公開しても読み手の役に立たず、原本側に置くのが正です。

## 役割分担のまとめ

| 置き場所 | 正とするもの |
|---|---|
| bot-workspace | 方針・ルール・仕事の状態（台帳） |
| secondbrain | 事実・決定・状態・学び（知識） |
| botsetup | やり方の公開まとめ |

「ルール文書と知識が矛盾したら、ルール文書が勝ち、矛盾は決定の記録に残して直す」という優先順位を決めてあります。
