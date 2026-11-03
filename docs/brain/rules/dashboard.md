> 公開版：非公開 repo（secondbrain）の文書の複製です。公開にあたり固有名の一部を調整しています。正は原本側にあります。

---
paths:
  - "projects/bot-workspace.md"
  - "notes/dashboard-*.md"
---
# ダッシュボード領域のルール

ダッシュボード（Bot オフィス）について、このブレインに書くときと、bot-workspace の `dashboard/` を触るときに読む。
正本はすべて bot-workspace repo にある。ここには文面を複写せず、どこを読むかだけを置く。

## 先に読むもの（bot-workspace repo）

- `docs/DASHBOARD-SPEC.md` — データ契約（§1）、分担（§4）、受け入れ基準（§5）。契約を変えるときは Muse に先に出す
- `docs/APPROVAL-CENTER.md` — 承認センターのボタンと反映の流れ、ボタンにしないもの
- `docs/MANAGEMENT.md` の「ダッシュボードの役割」 — 管理体制の可視化で、画面からは操作しない
- `dashboard/README.md` — 開き方、URL パラメータ、画面の読み方
- 状態の検査は `python3 tools/check_state.py`（bots.json / requests.json と BOARD・依頼ファイルのずれも見る）

## このブレインに書くときの決まり

- 仕様や契約の中身は書かない。結論と状態だけを書き、正本のファイル名を添える
- 実装の状態（どの REQ が検証中か、など）は `projects/bot-workspace.md` に書き、BOARD.md と矛盾させない
- 画面の数値（描画コール、fps など）を書くときは、誰がどの環境・どのデータで測ったかを付ける（RULES §4）
- 状態ファイルや画面に認証情報を埋め込まない（RULES §5、DASHBOARD-SPEC §3）
