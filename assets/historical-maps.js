// 古地図・航空写真は配信元から直接読み込み、タイルの独自保存・再配信は行わない。
(() => {
  const konjaku = 'https://ktgis.net/kjmapw/';
  const transparentTile = 'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%221%22%20height=%221%22/%3E';
  const configs = {
    showa: { label: '昭和の地図', catalog: './data/showa-map-regions.json' },
    prewar: { label: '戦前の地図', catalog: './data/prewar-map-regions.json' },
    postwarMap: {
      label: '終戦前後の地図', catalog: './data/postwar-map-regions.json',
      note: '道路・地名入り。戦後発行でも戦前の情報が残る図幅があります。'
    },
    postwarPhoto: {
      label: '終戦直後の航空写真',
      attribution: '航空写真：<a href="https://maps.gsi.go.jp/development/ichiran.html#ort_USA10" target="_blank" rel="noopener">国土地理院</a>（1945～1950年・一部地域）',
      note: '1945～1950年の写真が混在します。1945年の撮影日によっては終戦前を含みます。写真のない部分は現在の標準地図です。'
    }
  };
  const catalogs = new Map();
  function loadCatalog(url) {
    if (!catalogs.has(url)) {
      catalogs.set(url, fetch(url).then(response => {
        if (!response.ok) throw new Error(`歴史地図の収録情報: ${response.status}`);
        return response.json();
      }).catch(error => { catalogs.delete(url); throw error; }));
    }
    return catalogs.get(url);
  }
  const contains = (b, p) => b[0] <= p.lat && p.lat <= b[2] && b[1] <= p.lng && p.lng <= b[3];
  window.NauruHistoricalMaps = {
    createLayer({ key, fallbackLayer, textLevel = 0, onStatus }) {
      const config = configs[key];
      const group = L.layerGroup([fallbackLayer]);
      group.getAttribution = () => config.attribution
        || `歴史地図：<a href="${konjaku}" target="_blank" rel="noopener">今昔マップ on the web</a>（一部地域・範囲外は現在図）`;
      let activeMap, regions = [], tilesFailed = false, state = 'loading';
      const updateStatus = () => {
        if (!activeMap) return;
        let message;
        if (state === 'loading') {
          message = `${config.label}を読み込み中です。現在の標準地図を表示しています。`;
        } else if (state === 'error') {
          message = `${config.label}を読み込めません。現在の標準地図を表示しています。`;
        } else if (activeMap.getZoom() < 10) {
          message = `一部地域のみ。拡大すると${config.label}を表示します。現在は標準地図です。`;
        } else if (key === 'postwarPhoto') {
          message = `一部地域のみ。${config.note}`;
        } else {
          const point = activeMap.getCenter();
          const region = [...regions].reverse().find(r => contains(r.bounds, point) && r.areas.some(a => contains(a, point)));
          const date = region && (region.start === region.end ? `${region.start}年` : `${region.start}～${region.end}年`);
          message = region
            ? `一部地域のみ。中心付近：${region.name}・${date}の収録地図。範囲外は現在の標準地図です。`
            : '一部地域のみ。中心付近は収録範囲外のため、現在の標準地図を表示しています。';
          if (config.note) message += ` ${config.note}`;
        }
        if (tilesFailed && state === 'ready') message += ' 取得できない部分も標準地図で補います。';
        onStatus(message);
      };
      const addRegion = region => {
        const sheets = region.areas?.map(a => L.latLngBounds([[a[0], a[1]], [a[2], a[3]]]));
        const RegionalTiles = L.TileLayer.extend({
          _isValidTile(coords) {
            if (!L.TileLayer.prototype._isValidTile.call(this, coords)) return false;
            return !sheets || sheets.some(sheet => sheet.overlaps(this._tileCoordsToBounds(coords)));
          }
        });
        const layer = new RegionalTiles(region.url || `${konjaku}kjtilemap/${region.id}/${region.period}/{z}/{x}/{y}.png`, {
          tms: !region.url, noWrap: true,
          bounds: [[region.bounds[0], region.bounds[1]], [region.bounds[2], region.bounds[3]]],
          minZoom: 10, maxZoom: 19,
          minNativeZoom: (region.minNativeZoom || 8) + textLevel,
          maxNativeZoom: region.maxNativeZoom + textLevel,
          tileSize: 256 * Math.pow(2, textLevel), zoomOffset: -textLevel,
          crossOrigin: 'anonymous', errorTileUrl: transparentTile,
          className: `historical-map-tiles historical-map-${key}`, keepBuffer: 0
        });
        layer.on('tileerror', () => { tilesFailed = true; updateStatus(); });
        group.addLayer(layer);
      };
      group.on('add', async () => {
        activeMap = group._map;
        const map = activeMap;
        map.on('moveend zoomend', updateStatus);
        updateStatus();
        try {
          if (key === 'postwarPhoto') {
            addRegion({
              url: 'https://cyberjapandata.gsi.go.jp/xyz/ort_USA10/{z}/{x}/{y}.png',
              bounds: [20, 122, 46, 154], minNativeZoom: 10, maxNativeZoom: 17
            });
          } else {
            const catalog = await loadCatalog(config.catalog);
            if (activeMap !== map || !map.hasLayer(group)) return;
            // 広域・古い地図を下に敷き、重なる場所では新しい地域図を優先する。
            regions = [...catalog.regions].sort((a, b) => a.end - b.end
              || (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1])
                - (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]));
            regions.forEach(addRegion);
          }
          state = 'ready';
          updateStatus();
        } catch (error) {
          if (activeMap !== map) return;
          state = 'error';
          updateStatus();
          console.warn(`${config.label}の読み込みに失敗しました`, error);
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
