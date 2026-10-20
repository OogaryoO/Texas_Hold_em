# 德州撲克・六人桌

一位真人玩家對五個規則式電腦玩家的無限注德州撲克（盲注 10/20）。
玩家可註冊、登入，每一手結束後的籌碼與戰績都會寫入資料庫。

## 功能

- **帳號**：註冊即送 5,000 籌碼；密碼以 scrypt 雜湊保存，登入狀態用簽章過的 HttpOnly cookie（30 天）。
- **牌局**：伺服器端執行完整規則：盲注、四條街、最小加注、全下與邊池、未跟注退回、平分底池。
- **電腦玩家**：五種寫死的個性（緊凶、鬆弱、瘋狂、跟注站、岩石），依起手牌強度、成牌強度、聽牌與底池賠率決定動作；輸光會離桌並換新玩家入座。
- **保存**：每手結束寫入籌碼、手數、勝場、最大底池；排行榜依籌碼排序。籌碼少於大盲時可領 1,000 救濟金。
- 前端是無建置步驟的純 HTML/CSS/JS，手機與桌機皆可玩。

## 本機執行

```bash
npm install
npm start          # http://localhost:3000
npm test           # 牌型比較與 1,500 手籌碼守恆測試
```

## 資料庫

啟動時自動選擇：

| 條件 | 儲存 |
| --- | --- |
| 設定了 `DATABASE_URL` | PostgreSQL（TLS，pool 斷線自動重連） |
| 否則 | 內建 `node:sqlite`，檔案在 `DATA_DIR`（預設 `./data`，不可寫時改用系統暫存目錄） |
| Node 版本沒有 `node:sqlite` | JSON 檔（備援，確保服務仍能啟動） |

## 部署到 BellD（staging）

本專案依 `AGENTS.md` 的規則撰寫：`package.json` 在根目錄、`scripts.start` 存在、
監聽 `process.env.PORT`、`/` 回應 200、綁定所有介面、已提交 `package-lock.json`、
相依套件只來自 npm registry 且沒有 install script。

在 Console（`https://console.staging.belld.ai`）→ **Services** → **Create service from repository**，
Repository URL 填這個 repo、Git ref 填 `main`、Subdirectory 留空。

**資料保存的注意事項**：BellD 文件沒有說明本機磁碟在重啟或重新部署後是否保留，也沒有提供
託管資料庫。預設的 SQLite 檔在 BellD 上應視為**可能會遺失**。若要長期保存：

1. 準備一個可用 IPv4 連線的 PostgreSQL（例如供應商的 pooler 主機）。
2. 需要付費方案（Free 方案封鎖所有對外連線），並在 `package.json` 宣告：
   ```json
   { "belld": { "egress": ["你的資料庫主機:5432"] } }
   ```
3. 在 Console 的 **Variables** 設定 secret `DATABASE_URL`（不要提交到 repo）。

可選變數：`SESSION_SECRET`（未設定時自動產生並存在資料庫）、`DATA_DIR`。
