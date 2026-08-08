# OSM境界データ変換スキル

OSMの候補を特定し、完全なrelation/wayの形状を検証して、画像化可能なGeoJSON・metadata・SVG仕様へ保存するCodexスキルです。

## 実行

リポジトリのルートから、同梱コンバーターを起動します。

```text
node skills/osm-boundary-conversion/scripts/convert_osm_boundary.mjs --name "淡路島" --kind island --context "兵庫県 日本" --output-dir outputs
```

既に確認済みのOSM IDがある場合は、名前検索を省略して固定IDを直接取得できます。

```text
node skills/osm-boundary-conversion/scripts/convert_osm_boundary.mjs --osm-type relation --osm-id 4051287 --name "高松市" --kind administrative-area --context "香川県 日本" --output-dir outputs
```

行政relationの`subarea`は再帰取得し、各下位relationの陸地を独立した`MultiPolygon`として保存します。`maritime=yes`の海側境界を含むrelationでは、必要なときだけ同じbboxの`natural=coastline`を1回取得し、海岸線で海域を切り落として本土を閉じ、bbox内の行政区域に含まれる閉じた海岸線を島ポリゴンとして追加します。海域を親relationの外側へ塗りつぶしたり、離れた島を線で接続したりしません。再生成時は`--reuse-cache`でOSM本体と海岸線応答を再利用できます。

出力の正本は詳細GeoJSONです。SVGやPNGはこのベクターから派生し、OSM/ODbLの出典と、投影済みの内容比率・キャンバス比率をmetadataに残します。SVGの表示用座標は小数6桁で保持して量子化による階段状の輪郭を防ぎ、正本のGeoJSONは無加工の詳細形状のまま保存します。使用した精度はmetadataの`export.svg.coordinatePrecision`に記録します。取得済みのraw応答や生成画像は、再利用が明示的に必要な場合だけ保存してください。
