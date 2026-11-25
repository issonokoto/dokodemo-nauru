async (page) => {
  await page.getByRole('button',{name:'サイドパネルを閉じる',exact:true}).click();
  await page.getByRole('button',{name:'screenshot-tokyo-1920x1080.png を削除',exact:true}).click();
  await page.getByRole('button',{name:'screenshot-osaka-1920x1080.png を削除',exact:true}).click();
  const phone = page.getByRole('group').filter({hasText:'携帯電話版のスクリーンショット'});
  await phone.getByRole('button',{name:'アセットを追加',exact:true}).click();
  await page.getByRole('button',{name:'アップロード',exact:true}).waitFor();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button',{name:'アップロード',exact:true}).click();
  await (await chooser).setFiles([
    'C:/Users/中尾洋一/Documents/どこでもナウル/google-play/store-assets/redesign-20261008/phone/01-tokyo-1080x1920.png',
    'C:/Users/中尾洋一/Documents/どこでもナウル/google-play/store-assets/redesign-20261008/phone/02-chiyoda-1080x1920.png',
    'C:/Users/中尾洋一/Documents/どこでもナウル/google-play/store-assets/redesign-20261008/phone/03-expo-1080x1920.png',
    'C:/Users/中尾洋一/Documents/どこでもナウル/google-play/store-assets/redesign-20261008/phone/04-quiz-1080x1920.png',
    'C:/Users/中尾洋一/Documents/どこでもナウル/google-play/store-assets/redesign-20261008/phone/05-photo-editor-1080x1920.png'
  ]);
  await page.getByRole('group',{name:'選択済みアセット 05-photo-editor-1080x1920.png',exact:true}).waitFor({timeout:60000});
  console.log('Phone screenshots uploaded.');
}
