# ストア画像の制作

完成画像は `google-play/store-assets/redesign-20261008/`。

1. `node tools/store-assets-20261008/capture.cjs` で公開版の比較画面・クイズ・写真編集画面を撮影する。
2. `node tools/store-assets-20261008/retake-map.cjs` で東京の地図を撮影する。公開版の中央固定による描画レイヤーに依存せず、アプリの「中央固定を解除」操作を使って地点にナウルくんを置く。画像内の実寸や形は変更しない。
3. `node tools/store-assets-20261008/render.cjs` でスマホ5枚、タブレット4枚、フィーチャーグラフィック、一覧プレビューを生成する。

既存のCodex付属のNode.js、Playwright、sharpとMicrosoft Edgeを使用する。パッケージの場所は各スクリプト冒頭に指定している。各画像はPNG RGB、スマホ1080×1920、タブレット1920×1080、フィーチャーグラフィック1024×500。

アプリのHTMLは変更しない。宣伝用の見出しは外枠にのみ配置する。写真編集では `source/beach-demo.png` を背景としてアプリ内で読み込む。

背景の生成プロンプト、フォントのOFLライセンス、元の高解像度スクリーンショットを完成素材のフォルダーに保存している。
