// 今昔マップの公開タイルを直接表示する。地図画像は保存・再配信しない。
(() => {
  const source = 'https://ktgis.net/kjmapw/';
  const transparentTile = 'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%221%22%20height=%221%22/%3E';
  let catalogPromise;
  function loadCatalog() {
    if (!catalogPromise) {
      catalogPromise = fetch('./data/showa-map-regions.json').then(response => {
        if (!response.ok) throw new Error(`昭和地図の収録情報: ${response.status}`);
        return response.json();
      }).catch(error => { catalogPromise = null; throw error; });
    }
    return catalogPromise;
  }
  const contains = (b, p) => b[0] <= p.lat && p.lat <= b[2] && b[1] <= p.lng && p.lng <= b[3];
  window.NauruShowaMap = {
    createLayer(fallbackLayer, textLevel, onStatus) {
      const group = L.layerGroup([fallbackLayer]);
      group.getAttribution = () => `歴史地図：<a href="${source}" target="_blank" rel="noopener">今昔マップ on the web</a>（一部地域・範囲外は現在図）`;
      let activeMap, regions = [], tilesFailed = false, state = 'loading';
      const updateStatus = () => {
        if (!activeMap) return;
        let message;
        if (state === 'loading') {
          message = '昭和の地図を読み込み中です。現在の標準地図を表示しています。';
        } else if (state === 'error') {
          message = '昭和の地図を読み込めません。現在の標準地図を表示しています。';
        } else if (activeMap.getZoom() < 10) {
          message = '一部地域のみ。拡大すると昭和の地図を表示します。現在は標準地図です。';
        } else {
          const point = activeMap.getCenter();
          const region = [...regions].reverse().find(r => contains(r.bounds, point) && r.areas.some(a => contains(a, point)));
          const date = region && (region.start === region.end ? `${region.start}年` : `${region.start}～${region.end}年`);
          message = region
            ? `一部地域のみ。中心付近：${region.name}・${date}の収録地図。範囲外は現在の標準地図です。`
            : '一部地域のみ。中心付近は収録範囲外のため、現在の標準地図を表示しています。';
          if (tilesFailed) message += ' 取得できない部分も標準地図で補います。';
        }
        onStatus(message);
      };
      group.on('add', async () => {
        activeMap = group._map;
        const map = activeMap;
        map.on('moveend zoomend', updateStatus);
        updateStatus();
        try {
          const catalog = await loadCatalog();
          if (activeMap !== map || !map.hasLayer(group)) return;
          // 広域・古い地図を下に敷き、重なる場所では新しい地域図を優先する。
          regions = [...catalog.regions].sort((a, b) => a.end - b.end
            || (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1])
              - (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]));
          for (const region of regions) {
            const sheets = region.areas.map(a => L.latLngBounds([[a[0], a[1]], [a[2], a[3]]]));
            const RegionalTiles = L.TileLayer.extend({
              _isValidTile(coords) {
                if (!L.TileLayer.prototype._isValidTile.call(this, coords)) return false;
                return sheets.some(sheet => sheet.overlaps(this._tileCoordsToBounds(coords)));
              }
            });
            const layer = new RegionalTiles(`${source}kjtilemap/${region.id}/${region.period}/{z}/{x}/{y}.png`, {
              tms: true, noWrap: true,
              bounds: [[region.bounds[0], region.bounds[1]], [region.bounds[2], region.bounds[3]]],
              minZoom: 10, maxZoom: 19,
              minNativeZoom: 8 + textLevel, maxNativeZoom: region.maxNativeZoom + textLevel,
              tileSize: 256 * Math.pow(2, textLevel), zoomOffset: -textLevel,
              crossOrigin: 'anonymous', errorTileUrl: transparentTile,
              className: 'showa-map-tiles', keepBuffer: 0
            });
            layer.on('tileerror', () => { tilesFailed = true; updateStatus(); });
            group.addLayer(layer);
          }
          state = 'ready';
          updateStatus();
        } catch (error) {
          if (activeMap !== map) return;
          state = 'error';
          updateStatus();
          console.warn('昭和地図の読み込みに失敗しました', error);
        }
      });
      group.on('remove', () => {
        if (activeMap) activeMap.off('moveend zoomend', updateStatus);
        activeMap = null;
      });
      return group;
    }
  };
})();
