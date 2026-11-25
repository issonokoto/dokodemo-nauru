async (page) => {
  await page.getByRole('button',{name:'サイドパネルを閉じる',exact:true}).click();
  for (const label of ['7 インチ タブレット版のスクリーンショット','10 インチ タブレット版のスクリーンショット']) {
    const group=page.getByRole('group').filter({hasText:label});
    await group.getByRole('button',{name:'screenshot-tokyo-1920x1080.png を削除',exact:true}).click();
    await group.getByRole('button',{name:'screenshot-osaka-1920x1080.png を削除',exact:true}).click();
  }
  const group=page.getByRole('group').filter({hasText:'7 インチ タブレット版のスクリーンショット'});
  await group.getByRole('button',{name:'アセットを追加',exact:true}).click();
  await page.getByRole('button',{name:'アップロード',exact:true}).click();
}
