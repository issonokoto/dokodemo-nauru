# OSM境界コンバーター開発コピー

正式スキル付属コンバーターを、Codexの実行可能な作業領域内で開発・検証するためのコピーです。公開・インストール時は、`convert_osm_boundary.mjs`と`test_convert_osm_boundary.mjs`のSHA-256が正式スキル内のファイルと一致することを確認します。

## 実行例

```text
node tools/osm-boundary-conversion/convert_osm_boundary.mjs --osm-type relation --osm-id 900329 --name "神戸市" --kind administrative-area --context "兵庫県 日本" --output-dir outputs/kobe --cache-dir .osm-boundary-cache --reuse-cache --deep
```

初回は親relationとmember wayのgeometryだけを取得し、親外周がない場合に限って直接`subarea`へ拡張します。海側外周に`maritime=yes`がある行政境界は、実際の`natural=coastline`との交点で陸地化します。閉じた海岸wayだけでなく複数wayから成る島も独立ポリゴンとして保存し、本土へ接続しません。

`--cache-dir`を固定すると、別の`--output-dir`でもOSM本体・海岸線・取得元レシートを再利用できます。公開Overpassは短い時間差で候補を並行開始し、最初の成功だけ採用して他を中止します。全候補が失敗した場合は、完了済みキャッシュを残して停止します。

出力は詳細GeoJSON、metadata、SVGプレビューです。SVGはピクセル座標のviewBoxへ単一倍率で写像し、縦横比誤差と量子化誤差をmetadataへ記録します。面ジオメトリは通常実行でも自己交差を検査します。

## テスト

```text
node --test tools/osm-boundary-conversion/test_convert_osm_boundary.mjs
```
