async (page) => {
  await page.getByRole('button',{name:'選択をすべて解除',exact:true}).click();
  for(const name of ['01-tokyo','02-chiyoda','03-expo','04-quiz','05-photo-editor']) {
    await page.getByRole('group',{name:'選択解除済みアセット '+name+'-1080x1920.png',exact:true}).click();
  }
  await page.getByRole('button',{name:'追加',exact:true}).click();
  await page.getByRole('button',{name:'05-photo-editor-1080x1920.png の詳細を表示',exact:true}).waitFor();
  const feature = page.getByRole('group').filter({hasText:'フィーチャー グラフィックは PNG'});
  await feature.getByRole('button',{name:'アセットを追加',exact:true}).click();
  const row = page.getByRole('listitem',{name:'Asset row',exact:true})
    .filter({hasText:'feature-graphic-1024x500.png'})
    .filter({hasText:'2026年10月8日'});
  await row.getByRole('group',{name:'選択解除済みアセット feature-graphic-1024x500.png',exact:true}).click();
  await page.getByRole('button',{name:'追加',exact:true}).click();
  await page.getByRole('button',{name:'feature-graphic-1024x500.png の詳細を表示',exact:true}).waitFor();
  await page.getByRole('button',{name:'コンテンツを表示: タブレットのアセット',exact:true}).click();
}
