async (page) => {
  const labels=[
    'フィーチャー グラフィック - feature-graphic-1024x500.png',
    '携帯電話版のスクリーンショット - 01-tokyo-1080x1920.png',
    '携帯電話版のスクリーンショット - 02-chiyoda-1080x1920.png',
    '携帯電話版のスクリーンショット - 03-expo-1080x1920.png',
    '携帯電話版のスクリーンショット - 04-quiz-1080x1920.png',
    '携帯電話版のスクリーンショット - 05-photo-editor-1080x1920.png'
  ];
  for(const name of labels)await page.getByRole('checkbox',{name,exact:true}).check();
  await page.screenshot({path:'outputs/store-publication-20261008/02-ai-declaration.png',fullPage:true});
  await page.getByRole('button',{name:'アセットにラベルを付けて送信',exact:true}).click();
  return {declaredAssets:labels,url:page.url()};
}
