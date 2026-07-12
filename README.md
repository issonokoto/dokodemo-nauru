# どこでもナウル

ナウル共和国の実寸シルエットを地図上に重ねて、大きさの感覚を体感するWebアプリです。

## 使い方

1. このリポジトリを GitHub Pages で公開する（下記）
2. またはローカルで `index.html` を静的サーバー経由で開く

```bash
# 例
python -m http.server 8765
# → http://127.0.0.1:8765/
```

## GitHub Pages での公開

1. GitHub に新しいリポジトリを作成（例: `dokodemo-nauru`）
2. このフォルダの内容を push
3. リポジトリ **Settings → Pages**
4. Source: **Deploy from a branch**
5. Branch: `main` / folder: `/ (root)` → Save
6. 数分後: `https://<ユーザー名>.github.io/dokodemo-nauru/`

## クレジット

- 地図タイル: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors / CARTO / OpenTopoMap / Esri 等
- 境界データ: geoBoundaries（OSM 系）
- ナウルくん © ナウル共和国政府観光局
- メルカトル図法上の実寸比較という体験は、既存の True Size 系・「どこでも〜マップ」系の着想を参考にしています

## 注意

本サイトはスケール感を体験するシミュレーターです。厳密な測量・面積計算には使用できません。
