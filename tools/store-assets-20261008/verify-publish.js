async (page) => {
  const expected={
    '携帯電話版のスクリーンショット':['01-tokyo-1080x1920.png','02-chiyoda-1080x1920.png','03-expo-1080x1920.png','04-quiz-1080x1920.png','05-photo-editor-1080x1920.png'],
    '7 インチ タブレット版のスクリーンショット':['01-tokyo-1920x1080.png','02-chiyoda-1920x1080.png','03-expo-1920x1080.png','04-quiz-1920x1080.png'],
    '10 インチ タブレット版のスクリーンショット':['01-tokyo-1920x1080.png','02-chiyoda-1920x1080.png','03-expo-1920x1080.png','04-quiz-1920x1080.png']
  };
  const actual={};
  for(const label of Object.keys(expected)) {
    actual[label]=await page.getByRole('group').filter({hasText:label}).getByRole('img').evaluateAll(images=>images.map(i=>i.getAttribute('alt')));
    if(JSON.stringify(actual[label])!==JSON.stringify(expected[label]))throw new Error('Wrong image order: '+label+' '+JSON.stringify(actual[label]));
  }
  await page.screenshot({path:'outputs/store-publication-20261008/01-assets-configured.png',fullPage:true});
  return {url:page.url(),images:actual,featureGraphic:await page.getByRole('button',{name:'feature-graphic-1024x500.png の詳細を表示',exact:true}).count()};
}
