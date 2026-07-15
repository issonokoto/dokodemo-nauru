import fs from 'node:fs';

const catalogPath = 'data/natural-features.geojson';
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const prefectures = {
  '十三湖': '青森県',
  '尾駮沼': '青森県',
  '宇曽利山湖': '青森県',
  '市柳沼': '青森県',
  '田面木沼': '青森県',
  '鷹架沼': '青森県',
  '姉沼': '青森県',
  '田光沼': '青森県',
  '長沼': '青森県',
  '鳥の海': '宮城県',
  '長面浦': '宮城県',
  '万石浦': '宮城県',
  '伊豆沼': '宮城県',
  '内沼': '宮城県',
  '八郎潟調整池': '秋田県',
  '浅内沼': '秋田県',
  '松川浦': '福島県',
  '秋元湖': '福島県',
  '小野川湖': '福島県',
  '沼沢湖': '福島県',
  '尾瀬沼': '福島県',
  '中禅寺湖': '栃木県',
  '牛久沼': '茨城県',
  '涸沼': '茨城県',
  '外浪逆浦': '茨城県',
  '手賀沼': '千葉県',
  '加茂湖': '新潟県',
  '鳥屋野潟': '新潟県',
  '木場潟': '石川県',
  '河北潟': '石川県',
  '北潟湖': '福井県',
  '本栖湖': '山梨県',
  '西湖': '山梨県',
  '河口湖': '山梨県',
  '木崎湖': '長野県',
  '野尻湖': '長野県',
  '佐鳴湖': '静岡県',
  '猪鼻湖': '静岡県',
  '西の湖': '滋賀県',
  '余呉湖': '滋賀県',
  '阿蘇海': '京都府',
  '湖山池': '鳥取県',
  '東郷池': '鳥取県',
  '神西湖': '島根県'
};

let updated = 0;
for (const feature of catalog.features) {
  const properties = feature.properties || {};
  if (properties.kind !== 'water' || !prefectures[properties.name]) continue;
  properties.context = prefectures[properties.name];
  if (properties.geometryFile) {
    const geometryPath = `data/${properties.geometryFile}`;
    const geometryFeature = JSON.parse(fs.readFileSync(geometryPath, 'utf8'));
    geometryFeature.properties.context = properties.context;
    fs.writeFileSync(geometryPath, `${JSON.stringify(geometryFeature)}\n`);
  }
  updated += 1;
}

catalog.generatedAt = new Date().toISOString();
fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`);
console.log(JSON.stringify({ updated }));
