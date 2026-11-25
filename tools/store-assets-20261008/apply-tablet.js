async (page) => {
  const names=['01-tokyo','02-chiyoda','03-expo','04-quiz'];
  await page.getByRole('group',{name:'選択済みアセット 04-quiz-1920x1080.png',exact:true}).waitFor({timeout:60000});
  await page.getByRole('button',{name:'選択をすべて解除',exact:true}).click();
  for(const name of names) await page.getByRole('group',{name:'選択解除済みアセット '+name+'-1920x1080.png',exact:true}).click();
  await page.getByRole('button',{name:'追加',exact:true}).click();
  await page.getByRole('button',{name:'サイドパネルを閉じる',exact:true}).click();
  const ten=page.getByRole('group').filter({hasText:'10 インチ タブレット版のスクリーンショット'});
  await ten.getByRole('button',{name:'アセットを追加',exact:true}).click();
  for(const name of names) await page.getByRole('group',{name:'選択解除済みアセット '+name+'-1920x1080.png',exact:true}).click();
  await page.getByRole('button',{name:'追加',exact:true}).click();
  await page.getByRole('button',{name:'サイドパネルを閉じる',exact:true}).click();
  const sections=['携帯電話版のスクリーンショット','7 インチ タブレット版のスクリーンショット','10 インチ タブレット版のスクリーンショット'];
  const result={};
  for(const label of sections){
    result[label]=await page.getByRole('group').filter({hasText:label}).getByRole('button').allTextContents();
  }
  return result;
}
