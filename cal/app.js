// ==========================================================================
// 1. 全局變數與資料庫初始化
// ==========================================================================
let rawData = null;           /* 儲存原始 JSON 完整資料 */
let stationsArray = [];       /* 儲存前處理過、貼好標籤的完整測站陣列 */
let currentFilteredList = []; /* 儲存目前被篩選出來的測站陣列，供 CSV 匯出使用 */
let currentSort = { column: null, direction: 'asc' }; /* 記錄表格目前的排序狀態 */
let manualExcludedSids = []; /* 儲存使用者在表格上手動剔除的測站 SID */

let taiwanGeoData = null;     /* 儲存台灣縣市邊界資料 */
let mapInstance = null;       /* Leaflet 地圖實體 */
let markersLayer = null;      /* 測站標記圖層 */

let markerDict = {};          /* 儲存地圖上每顆點點的實體，供搜尋引擎呼叫 */
let draggedFilterId = null;

let isSearchMode = false;
let searchTargetStation = null;

const activeFilters = {
    include: {},
    exclude: {}
};

let checkedSids = new Set();  /* 🆕 表格中目前勾選的測站 SID（排序、篩選後保留勾選） */
/* 資料監控頁連結：填入網址後，地圖資訊卡會出現「查看此站監控資料」按鈕；{sid} 會替換成站碼。
   例：'monitor.html?sid={sid}'。留空則不顯示。 */
const MONITOR_PAGE_URL = '';

/* 縣市由北到南的排序（縣市選項與鄉鎮選項共用） */
const NORTH_TO_SOUTH_CITIES = ["基隆市", "臺北市", "新北市", "桃園市", "新竹市", "新竹縣", "苗栗縣", "臺中市", "彰化縣", "南投縣", "雲林縣", "嘉義市", "嘉義縣", "臺南市", "高雄市", "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣", "澎湖縣", "金門縣", "連江縣"];
function cityOrder(cityName) {
    const i = NORTH_TO_SOUTH_CITIES.indexOf(cityName);
    return i === -1 ? 999 : i;
}

/* 🐛 鄉鎮代碼在 JSON 中是依「名稱」編號，不同縣市的同名區（如新竹市與嘉義市的「東區」）共用同一代碼，
   因此鄉鎮條件一律使用「縣市代碼-鄉鎮代碼」組合，才能區分 */
function townPairKey(city, town) { return `${city}-${town}`; }
function townLabel(key) {
    const [c, t] = String(key).split('-');
    return `${rawData.mappings.city[c] || ''}${rawData.mappings.town[t] || t}`;
}
function townGeoKey(key) {
    const [c, t] = String(key).split('-');
    return `${rawData.mappings.city[c] || '未知'}-${rawData.mappings.town[t] || '未知'}`;
}

/* 🆕 輕量提示訊息 */
function showCalToast(msg) {
    let t = document.getElementById('cal-toast');
    if (!t) { t = document.createElement('div'); t.id = 'cal-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}
function flashGroup(el) {
    el.classList.remove('flash');
    void el.offsetWidth;   // 重新觸發動畫
    el.classList.add('flash');
}

document.addEventListener("DOMContentLoaded", () => {
    const currentTimeStamp = new Date().getTime();

    fetch('taiwan.json')
        .then(response => response.json())
        .then(data => { taiwanGeoData = data; })
        .catch(err => console.error("台灣地圖載入失敗:", err));

    fetch('stationData.json?v=' + currentTimeStamp)
        .then(response => {
            dataLastModified = response.headers.get('Last-Modified');   // 🆕 資料更新時間
            return response.json();
        })
        .then(data => {
            rawData = data;
            initStationData();   
            initDragAndDrop();  
            initDefaultFilters(); 
            if (!applyStateFromURL()) calculateStations();   // 🆕 網址帶 ?q= 時還原查詢條件
            showDataUpdated();
        })
        .catch(err => console.error("JSON 資料載入失敗:", err));

    const exportBtn = document.getElementById('export-csv-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', exportToCSV);
    }

    const downloadMapBtn = document.getElementById('download-map-btn');
    if (downloadMapBtn) {
        downloadMapBtn.addEventListener('click', () => {
            const mapContainer = document.getElementById('map-container');
            if (!mapContainer) return;

            const zoomControl = mapContainer.querySelector('.leaflet-control-zoom');
            if (zoomControl) zoomControl.style.display = 'none';

            const modifiedElements = [];
            
            mapContainer.querySelectorAll('*').forEach(el => {
                const inlineTransform = el.style.transform;
                if (inlineTransform && inlineTransform.includes('translate3d')) {
                    modifiedElements.push({ el: el, oldTransform: inlineTransform });
                    el.style.transform = inlineTransform.replace('translate3d', 'translate');
                } 
                else {
                    const computedStyle = window.getComputedStyle(el);
                    const transformValue = computedStyle.transform || computedStyle.webkitTransform;
                    if (transformValue && transformValue.includes('matrix3d')) {
                        const match = transformValue.match(/matrix3d.*\((.+)\)/);
                        if (match) {
                            const matrixValues = match[1].split(', ');
                            const x = parseFloat(matrixValues[12]);
                            const y = parseFloat(matrixValues[13]);
                            modifiedElements.push({ el: el, oldTransform: el.style.transform });
                            el.style.transform = `matrix(1, 0, 0, 1, ${x}, ${y})`;
                        }
                    }
                }
            });

            html2canvas(mapContainer, {
                useCORS: true,         
                backgroundColor: '#ffffff',
                logging: false
            }).then(canvas => {
                if (zoomControl) zoomControl.style.display = '';
                modifiedElements.forEach(item => {
                    item.el.style.transform = item.oldTransform;
                });

                const link = document.createElement('a');
                link.download = `台灣測站分布地圖_${new Date().toISOString().slice(0,10)}.png`;
                link.href = canvas.toDataURL('image/png');
                link.click();
            }).catch(err => {
                console.error("地圖圖片導出失敗:", err);
                alert("圖片產生失敗。");
                if (zoomControl) zoomControl.style.display = '';
                modifiedElements.forEach(item => {
                    item.el.style.transform = item.oldTransform;
                });
            });
        });
    }

    const mapBtn = document.getElementById('show-map-btn');
    const closeMapBtn = document.getElementById('close-map-btn');
    const mapModal = document.getElementById('map-modal');
    const modalContent = document.querySelector('.modal-content');

    if (mapBtn && closeMapBtn && mapModal && modalContent) {
        mapBtn.addEventListener('click', () => {
            isSearchMode = false;
            searchTargetStation = null;
            const searchInput = document.getElementById('station-search-input');
            if (searchInput) searchInput.value = '';

            modalContent.style.position = '';
            modalContent.style.top = '';
            modalContent.style.left = '';
            modalContent.style.width = '';
            modalContent.style.height = '';
            modalContent.style.margin = '';
            modalContent.style.transform = '';
            
            mapModal.classList.add('active');
            renderMap(); 
        });

        closeMapBtn.addEventListener('click', () => {
            mapModal.classList.remove('active');
        });

        mapModal.addEventListener('click', (e) => {
            if (e.target === mapModal) {
                mapModal.classList.remove('active');
            }
        });
    }

    initMainPanelResizer(); 
    initSubPanelResizer();  
    initModalResizer();  
    initSearchEngine(); 
    initResetButton(); 
    initTableSorting();
    initBatchDelete(); 
    initZoneResizer(); 
    initPresetsAndShare();   // 🆕 常用查詢、分享連結
    initStatsModal();        // 🆕 分組統計
    initHealthModal();       // 🆕 資料健檢
    initToolModals();
});

// ==========================================================================
// 🛠️ 控制面板拉伸功能
// ==========================================================================
function initMainPanelResizer() {
    const resizer = document.getElementById('main-panel-resizer');
    const container = document.querySelector('.app-container');
    if (!resizer || !container) return;

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        resizer.classList.add('resizing');

        const onMouseMove = (moveEvent) => {
            const newRightWidth = window.innerWidth - moveEvent.clientX;
            if (newRightWidth > 300 && newRightWidth < window.innerWidth * 0.6) {
                container.style.gridTemplateColumns = `280px 1fr 6px ${newRightWidth}px`;
            }
        };

        const onMouseUp = () => {
            resizer.classList.remove('resizing');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

// ==========================================================================
// 2. 資料前處理 (Data Transformation & Tagging)
// ==========================================================================
function initStationData() {
    stationsArray = Object.values(rawData.allStations);

    stationsArray.forEach(station => {
        // 🧹 JSON 中部分站碼為文字 "nan"（轉檔殘留），視同沒有站碼
        if (typeof station.cwbid === 'string' && ['nan', 'none', 'null'].includes(station.cwbid.trim().toLowerCase())) {
            station.cwbid = '';
            station._cwbidWasNan = true;   // 供資料健檢列出
        }
        station._derivedUnit = getDerivedUnitString(station);
        station._derivedVendor = getDerivedVendorString(station);
        station._derivedTransport = getTransportType(station.sub_cat);
        station._derivedWeatherFreq = getWeatherFreq(station.sub_cat);
        station._derivedRainFreq = getRainFreq(station.sub_cat);

        if (Number(station.station_publish) === 0) {
            station._derivedStatus = "未上架";
        } else {
            station._derivedStatus = "正式上架";
        }

        station.supply_channels = []; 
        if (station.data_supply && typeof station.data_supply === 'object') {
            Object.entries(station.data_supply).forEach(([code, value]) => {
                if (Number(value) === 1 || value === true || value === "true") {
                    const channelName = (rawData.mappings && rawData.mappings.data_supply && rawData.mappings.data_supply[code]) 
                                        ? rawData.mappings.data_supply[code] 
                                        : code;
                    station.supply_channels.push(channelName);
                }
            });
        }
    });

    // ⚡ 以 Map 查找，避免在迴圈中反覆 find 整個陣列
    const sidMap = new Map(stationsArray.map(s => [s.sid, s]));
    const cwbidMap = new Map(stationsArray.filter(s => s.cwbid).map(s => [s.cwbid, s]));

    // 💡 建立中繼站的巢狀族譜 (利用 JSON 裡的 repid 屬性)
    stationsArray.forEach(station => {
        station._upstream_relay_names = []; 
        
        let currentRepid = station.repid;
        let safeCounter = 0; 
        
        while (currentRepid && safeCounter < 20) {
            let parentStation = sidMap.get(currentRepid);
            if (parentStation) {
                station._upstream_relay_names.push(parentStation.n);
                currentRepid = parentStation.repid;
            } else {
                break; 
            }
            safeCounter++;
        }
    });

    // 💡 建立動態區域站歸屬長輩標籤
    if (rawData.treeData && rawData.treeData["署屬站"] && rawData.treeData["署屬站"]["區域站"]) {
        const regCenters = rawData.treeData["署屬站"]["區域站"];
        Object.entries(regCenters).forEach(([regName, regNode]) => {
            const extractIds = (node) => {
                if (Array.isArray(node)) return node;
                if (typeof node === 'object' && node !== null) {
                    let res = [];
                    Object.values(node).forEach(child => { res = res.concat(extractIds(child)); });
                    return res;
                }
                return [];
            };
            const allChildrenIds = extractIds(regNode);
            allChildrenIds.forEach(childId => {
                const targetStation = sidMap.get(childId) || cwbidMap.get(childId);
                if (targetStation) {
                    targetStation._my_regional_boss = regName;
                }
            });
        });
    }
}

function getDerivedUnitString(station) {
    if (station.main_cat != 7) return rawData.mappings.main[station.main_cat] || "其他";
    const subName = rawData.mappings.sub[station.sub_cat] || "外單位雨量站";
    if (station.sub_cat == 11) {
        if (station.vendor == 5) return "北市府大地工程處";
        if (station.vendor == 6) return "北市府水利工程處";
        return "北市府(其他)";
    }
    return subName;
}

function getDerivedVendorString(station) {
    if (station.vendor != 7) return rawData.mappings.vendor[station.vendor] || "未知";
    if (station.reg == 23) return "十河分署-翡翠水庫";
    if (station.reg == 24) return "十河分署-石門水庫";
    if (station.reg == 25) return "十河分署-第10河川局";
    return "十河分署";
}

function getTransportType(sub) {
    if (sub == 8) return "無線電";
    if ([3, 5, 6, 9, "3", "5", "6", "9"].includes(sub)) return "4G";
    if ([1, 2, "1", "2"].includes(sub)) return "實體網路";
    if ([10, 11, 12, 13, 14, 15, "10", "11", "12", "13", "14", "15"].includes(sub)) return "外單位雨量資料交換";
    return "未分類";
}
function getWeatherFreq(sub) {
    if ([10, 11, 12, 13, 14, 15, "10", "11", "12", "13", "14", "15"].includes(sub)) return "不接受篩選(純雨量站)";
    return sub == 8 ? "10分鐘" : "1分鐘";
}
function getRainFreq(sub) {
    return [10, 11, 12, 13, 14, 15, "10", "11", "12", "13", "14", "15"].includes(sub) ? "10分鐘" : "1分鐘";
}

// ==========================================================================
// 2.2 生成地圖測站資訊卡 (Popup)
// ==========================================================================
function generateStationPopupHtml(s) {
    try {
        const unit = s._derivedUnit || "未知單位";
        const regName = (rawData.mappings.reg && rawData.mappings.reg[s.reg]) ? rawData.mappings.reg[s.reg] : "無區域中心";
        const typeName = (rawData.mappings.station_type && rawData.mappings.station_type[s.station_type]) ? rawData.mappings.station_type[s.station_type] : "未知類型";
        const transport = s._derivedTransport || "未知傳輸";
        const vendor = s._derivedVendor || "無維護廠商";
        const alt = (s.alt !== undefined && s.alt !== null) ? `${s.alt}m` : "無高度資料";
        const status = s._derivedStatus || "未知狀態";
        
        const cityName = (rawData.mappings.city && rawData.mappings.city[s.city]) ? rawData.mappings.city[s.city] : "未知縣市";
        const townName = (rawData.mappings.town && rawData.mappings.town[s.town]) ? rawData.mappings.town[s.town] : "";

        const latDisplay = (s.lat !== undefined && s.lat !== null) ? parseFloat(s.lat).toFixed(4) : "無資料";
        const lonDisplay = (s.lon !== undefined && s.lon !== null) ? parseFloat(s.lon).toFixed(4) : "無資料";

        const weatherFreq = s._derivedWeatherFreq || "未知";
        const rainFreq = s._derivedRainFreq || "未知";

        let supplyTagsHtml = "";
        if (s.supply_channels && s.supply_channels.length > 0) {
            supplyTagsHtml = s.supply_channels.map(c => `<span style="background:#e0f2fe; color:#0284c7; border:1px solid #bae6fd; padding:3px 8px; border-radius:4px; font-size:0.75rem; white-space:nowrap;">${c}</span>`).join('');
        } else {
            supplyTagsHtml = `<span style="background:#f1f5f9; color:#64748b; border:1px solid #e2e8f0; padding:3px 8px; border-radius:4px; font-size:0.75rem;">無對外供應</span>`;
        }

        let warningHtml = "";
        if (status === "未上架" && s.publish_reason) {
            warningHtml = `
                <div style="margin: 10px 0; background:#fef2f2; color:#ef4444; border:1px solid #fecaca; padding:8px; border-radius:6px; font-size:0.85rem; font-weight:bold; text-align:left;">
                    🚧 未上架原因：<span style="font-weight:normal;">${s.publish_reason}</span>
                </div>`;
        }

        return `
            <div style="min-width: 280px; padding: 4px; font-family: inherit;">
                <div style="text-align:center; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px; margin-bottom: 10px;">
                    <strong style="font-size:1.3rem; color:#0f172a;">${s.n}</strong>
                    <span style="color:#64748b; font-size:0.9rem; margin-left:4px;">(${s.cwbid || s.sid})</span>
                    <div style="color:#0284c7; font-size:0.9rem; margin-top:6px; font-weight:bold; display: flex; align-items: center; justify-content: center; gap: 4px;">
                        <span>📍</span> ${cityName} ${townName}
                    </div>
                </div>

                ${warningHtml}
                
                <div style="background:#f8fafc; border:1px solid #cbd5e1; border-radius:6px; padding:10px; margin-bottom:12px;">
                    <strong style="color:#1e293b; font-size:0.85rem;">🏢 管理與通訊路徑：</strong><br>
                    <div style="margin-top:8px; font-weight:500; color:#334155; font-size:0.85rem; line-height: 1.6; display: flex; flex-wrap: wrap; align-items: center; gap: 4px;">
                        <span style="background: white; padding: 2px 6px; border-radius: 4px; border: 1px solid #e2e8f0; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">${unit}</span>
                        <span style="color:#94a3b8; font-size:0.7rem;">▶</span> 
                        <span style="background: white; padding: 2px 6px; border-radius: 4px; border: 1px solid #e2e8f0; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">${regName}</span>
                        <span style="color:#94a3b8; font-size:0.7rem;">▶</span> 
                        <span style="background: white; padding: 2px 6px; border-radius: 4px; border: 1px solid #e2e8f0; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">${typeName}</span>
                        <span style="color:#94a3b8; font-size:0.7rem;">▶</span> 
                        <span style="background: white; padding: 2px 6px; border-radius: 4px; border: 1px solid #e2e8f0; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">${transport}</span>
                    </div>
                </div>

                <div style="font-size: 0.8rem; color: #1e293b; margin-bottom: 6px; font-weight:bold;">🏷️ 測站屬性：</div>
                <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px;">
                    <span style="background:#f1f5f9; border:1px solid #cbd5e1; padding:3px 8px; border-radius:4px; font-size:0.75rem; color:#475569;">⛰️ 海拔 ${alt}</span>
                    <span style="background:#f1f5f9; border:1px solid #cbd5e1; padding:3px 8px; border-radius:4px; font-size:0.75rem; color:#475569;">🌐 經緯度 ${latDisplay}, ${lonDisplay}</span>
                    <span style="background:#f1f5f9; border:1px solid #cbd5e1; padding:3px 8px; border-radius:4px; font-size:0.75rem; color:#475569;">🛠️ ${vendor}</span>
                    
                    <span style="background:#f1f5f9; border:1px solid #cbd5e1; padding:3px 8px; border-radius:4px; font-size:0.75rem; color:#475569;">🌤️ 氣象頻率: ${weatherFreq}</span>
                    <span style="background:#f1f5f9; border:1px solid #cbd5e1; padding:3px 8px; border-radius:4px; font-size:0.75rem; color:#475569;">🌧️ 雨量頻率: ${rainFreq}</span>
                    
                    <span style="background:${status === '正式上架' ? '#dcfce7' : '#fee2e2'}; border:1px solid ${status === '正式上架' ? '#bbf7d0' : '#fecaca'}; padding:3px 8px; border-radius:4px; font-size:0.75rem; color:${status === '正式上架' ? '#16a34a' : '#ef4444'}; font-weight:bold;">${status === '正式上架' ? '✅ 正式上架' : '❌ 未上架'}</span>
                </div>
                
                <div style="border-top: 1px dashed #cbd5e1; padding-top: 12px;">
                    <div style="font-size: 0.8rem; color: #1e293b; margin-bottom: 8px; font-weight:bold;">📦 資料供應狀態：</div>
                    <div style="display:flex; flex-wrap:wrap; gap:6px;">
                        ${supplyTagsHtml}
                    </div>
                </div>

                ${MONITOR_PAGE_URL ? `
                <div style="margin-top: 12px; text-align: center;">
                    <a href="${MONITOR_PAGE_URL.replace('{sid}', encodeURIComponent(s.sid))}" target="_blank" rel="noopener"
                       style="display:inline-block; padding:6px 12px; font-size:0.8rem; font-weight:bold; color:#0284c7; background:#f0f9ff; border:1px solid #bae6fd; border-radius:6px; text-decoration:none;">
                        📈 查看此站監控資料
                    </a>
                </div>` : ''}
            </div>
        `;
    } catch (e) {
        return `<div style="text-align:center; color:#ef4444; padding: 10px;">資料解析發生錯誤</div>`;
    }
}

function initSearchEngine() {
    const searchInput = document.getElementById('station-search-input');
    const searchBtn = document.getElementById('station-search-btn');
    const suggestionsBox = document.getElementById('search-suggestions');
    const clearBtn = document.getElementById('clearBtn');

    if (!searchInput || !searchBtn) return;

    const executeSearch = (targetStation) => {
        if (!targetStation) return;
        searchInput.value = `${targetStation.n} (${targetStation.cwbid || targetStation.sid})`;
        if (suggestionsBox) suggestionsBox.style.display = 'none';
        focusStationOnMap(targetStation);
    };

    searchInput.addEventListener('input', () => {
        const rawQuery = searchInput.value.trim();
        
        if (rawQuery === '') {
            isSearchMode = false;
            searchTargetStation = null;
            if (clearBtn) clearBtn.style.display = 'none';
            if (suggestionsBox) suggestionsBox.style.display = 'none';
            return;
        }

        if (clearBtn) clearBtn.style.display = 'inline-block';
        if (stationsArray.length === 0) return;

        const normalizedQuery = rawQuery.toLowerCase().replace(/台/g, '臺');
        const keywords = normalizedQuery.split(/\s+/).filter(k => k.length > 0);

        let matchedStations = stationsArray.filter(s => {
            const cityName = rawData.mappings.city[s.city] || "";
            const townName = rawData.mappings.town[s.town] || "";
            const stationName = String(s.n || "").replace(/台/g, '臺');
            const sid = String(s.sid || "").toLowerCase();
            const cwbid = String(s.cwbid || "").toLowerCase();
            const combinedText = `${sid} ${cwbid} ${stationName} ${cityName} ${townName}`.toLowerCase();
            return keywords.every(kw => combinedText.includes(kw));
        });

        matchedStations.sort((a, b) => {
            const nameA = String(a.n || "").replace(/台/g, '臺');
            const nameB = String(b.n || "").replace(/台/g, '臺');
            const idA = String(a.cwbid || a.sid || "").toLowerCase();
            const idB = String(b.cwbid || b.sid || "").toLowerCase();

            const getScore = (name, id) => {
                let score = 0;
                if (name === normalizedQuery || id === normalizedQuery) score += 100;
                else if (name.startsWith(normalizedQuery)) score += 80;
                else if (name.includes(normalizedQuery)) score += 50;
                else if (id.includes(normalizedQuery)) score += 30;

                keywords.forEach(kw => { if (name.includes(kw)) score += 10; });
                return score;
            };

            const scoreA = getScore(nameA, idA);
            const scoreB = getScore(nameB, idB);

            if (scoreA !== scoreB) return scoreB - scoreA;
            return nameA.localeCompare(nameB, 'zh-Hant');
        });

        matchedStations = matchedStations.slice(0, 15);

        if (matchedStations.length > 0) {
            suggestionsBox.innerHTML = matchedStations.map(s => {
                const cityName = rawData.mappings.city[s.city] || "";
                const townName = rawData.mappings.town[s.town] || "";
                return `
                    <li class="suggestion-item" data-sid="${s.sid}" style="padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #f1f5f9; color: #334155; font-size: 0.9rem; display: flex; justify-content: space-between; transition: background 0.2s;" onmouseover="this.style.backgroundColor='#f8fafc'" onmouseout="this.style.backgroundColor='transparent'">
                        <span><strong style="color: #0f172a;">${s.n}</strong> <span style="color:#64748b; font-size:0.8rem; margin-left: 4px;">(${s.cwbid || s.sid})</span></span>
                        <span style="font-size:0.8rem; color:#94a3b8;">${cityName}${townName}</span>
                    </li>
                `;
            }).join('');
            suggestionsBox.style.display = 'block';

            suggestionsBox.querySelectorAll('.suggestion-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    const sid = e.currentTarget.getAttribute('data-sid');
                    const target = stationsArray.find(s => String(s.sid) === String(sid));
                    executeSearch(target);
                });
            });
        } else {
            suggestionsBox.innerHTML = `<li style="padding: 12px; color: #94a3b8; font-size: 0.9rem; text-align: center;">找不到符合「${rawQuery}」的測站</li>`;
            suggestionsBox.style.display = 'block';
        }
    });

    const performSearch = () => {
        const rawQuery = searchInput.value.trim();
        if (!rawQuery) {
            alert("請先輸入站名或代碼！");
            return;
        }
        const firstMatchItem = suggestionsBox.querySelector('.suggestion-item');
        if (firstMatchItem) {
            firstMatchItem.click();
        } else if (suggestionsBox.style.display === 'none' && searchTargetStation) {
             executeSearch(searchTargetStation);
        } else {
            alert(`找不到包含「${rawQuery}」的測站，請更換關鍵字再試！`);
        }
    };

    searchBtn.addEventListener('click', performSearch);
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            performSearch();
        }
    });

    document.addEventListener('click', (e) => {
        if (!searchInput.contains(e.target) && !suggestionsBox.contains(e.target)) {
            suggestionsBox.style.display = 'none';
        }
    });
}

function clearSearch() {
    const searchInput = document.getElementById('station-search-input');
    const clearBtn = document.getElementById('clearBtn');
    const suggestionsBox = document.getElementById('search-suggestions');

    if (searchInput) searchInput.value = "";
    if (clearBtn) clearBtn.style.display = "none";
    if (suggestionsBox) suggestionsBox.style.display = "none";

    isSearchMode = false;
    searchTargetStation = null;

    const mapModal = document.getElementById('map-modal');
    if (mapModal && mapModal.classList.contains('active')) {
        renderMap();
    }
}

// ==========================================================================
// 3. 拖曳介面與常規函數
// ==========================================================================
function initDragAndDrop() {
    const cards = document.querySelectorAll('.filter-card');
    const dropZones = document.querySelectorAll('.drop-zone');

    cards.forEach(card => {
        card.addEventListener('dragstart', (e) => {
            draggedFilterId = card.getAttribute('data-filter');
            card.style.opacity = '0.4';
        });
        card.addEventListener('dragend', (e) => {
            card.style.opacity = '1';
        });

        // 🆕 點一下（或鍵盤 Enter）直接加入包含池，觸控螢幕也能操作
        const filterId = card.getAttribute('data-filter');
        if (!filterId) return;   // 建置中的卡片
        card.setAttribute('tabindex', '0');
        card.addEventListener('click', () => addFilterToZone('include', filterId));
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addFilterToZone('include', filterId); }
        });
    });

    dropZones.forEach(zone => {
        const zoneType = zone.getAttribute('data-zone');

        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('drag-over');
        });

        zone.addEventListener('dragleave', () => {
            zone.classList.remove('drag-over');
        });

        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('drag-over');
            
            if (draggedFilterId) {
                addFilterToZone(zoneType, draggedFilterId);
                draggedFilterId = null;
            }
        });
    });
}

// 🆕 加入條件卡片（拖曳與點擊共用）；已存在時提示並閃爍該卡片，不再默默沒反應
function addFilterToZone(zoneType, filterId) {
    const existing = document.getElementById(`${zoneType}-group-${filterId}`);
    const zoneName = zoneType === 'include' ? '包含池' : '排除池';
    if (existing) {
        existing.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        flashGroup(existing);
        showCalToast(`「${getTitleByFilterId(filterId)}」已在${zoneName}中`);
        return;
    }
    const zone = document.querySelector(`.drop-zone[data-zone="${zoneType}"]`);
    if (!zone) return;
    renderFilterOptions(zone, zoneType, filterId);
    const added = document.getElementById(`${zoneType}-group-${filterId}`);
    if (added) {
        added.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        flashGroup(added);
    }
}

function initDefaultFilters() {
    const excludeZone = document.querySelector('.drop-zone[data-zone="exclude"]');
    if (!excludeZone) return;

    renderFilterOptions(excludeZone, 'exclude', 'status');
    const statusContainer = document.getElementById('exclude-options-status');
    if (statusContainer) {
        const checkboxStatus = statusContainer.querySelector('input[value="未上架"]');
        if (checkboxStatus) checkboxStatus.checked = true;
        activeFilters.exclude['status'] = ['未上架'];
    }
}

function renderFilterOptions(zone, zoneType, filterId) {
    const groupDiv = document.createElement('div');
    groupDiv.className = 'active-filter-group';
    groupDiv.id = `${zoneType}-group-${filterId}`;
    
    let title = getTitleByFilterId(filterId);

    let checkboxesHtml = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; border-bottom:1px solid #475569; padding-bottom:4px;">
            <strong style="color:#67e8f9;">🔍 ${title}</strong>
            <button onclick="removeFilterGroup('${zoneType}', '${filterId}')" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:0.8rem;">❌ 移除</button>
        </div>
    `;

    if (filterId === 'altitude') {
        checkboxesHtml += `
            <div id="${zoneType}-altitude-rows" style="display:flex; flex-direction:column; gap:8px; padding:8px 0;">
                <div class="altitude-row" style="display:flex; align-items:center; gap:6px;">
                    <input type="number" class="alt-min" placeholder="最低(m)" min="0" max="4000" 
                           style="width: 75px; padding: 6px; background:#1e293b; border: 1px solid #475569; border-radius: 6px; color:white; font-size:0.85rem;"
                           oninput="onAltitudeInputChange('${zoneType}')">
                    <span style="color:#94a3b8;">~</span>
                    <input type="number" class="alt-max" placeholder="最高(m)" min="0" max="4000" 
                           style="width: 75px; padding: 6px; background:#1e293b; border: 1px solid #475569; border-radius: 6px; color:white; font-size:0.85rem;"
                           oninput="onAltitudeInputChange('${zoneType}')">
                    <span style="font-size: 0.8rem; color: #94a3b8;">m</span>
                </div>
            </div>
            <button type="button" onclick="addAltitudeRow('${zoneType}')" 
                    style="margin-top:6px; background:#334155; border:1px dashed #475569; color:#67e8f9; padding:5px; border-radius:6px; font-size:0.75rem; cursor:pointer; width:100%; transition: background 0.2s;">
                ➕ 新增高度區間
            </button>
        `;
    } 
    else if (filterId === 'station-code-rule') {
        checkboxesHtml += `
            <div style="display:flex; flex-direction:column; gap:10px; padding:8px 0;">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #475569; padding-bottom:8px; margin-bottom:4px;">
                    <span style="font-size:0.85rem; color:#94a3b8;">多重條件邏輯：</span>
                    <select class="code-logic-select" onchange="onCodeRuleInputChange('${zoneType}')" style="background:#1e293b; border: 1px solid #475569; border-radius: 4px; color:white; font-size:0.8rem; padding:2px 6px; outline:none;">
                        <option value="or">符合任一 (聯集)</option>
                        <option value="and">符合全部 (交集)</option>
                    </select>
                </div>

                <div style="display:flex; gap:12px; border-bottom:1px dashed #475569; padding-bottom:10px;">
                    <label style="font-size:0.85rem; display:flex; align-items:center; gap:4px; cursor:pointer;">
                        <input type="checkbox" value="46start" class="quick-rule" onchange="onCodeRuleInputChange('${zoneType}')"> 46開頭(有人站)
                    </label>
                    <label style="font-size:0.85rem; display:flex; align-items:center; gap:4px; cursor:pointer;">
                        <input type="checkbox" value="2nd_2" class="quick-rule" onchange="onCodeRuleInputChange('${zoneType}')"> 第2碼為2(農業站)
                    </label>
                </div>
                
                <div id="${zoneType}-code-rule-rows" style="display:flex; flex-direction:column; gap:6px;"></div>
                
                <button type="button" onclick="addStationCodeRuleRow('${zoneType}')" 
                        style="margin-top:4px; background:#334155; border:1px dashed #475569; color:#67e8f9; padding:5px; border-radius:6px; font-size:0.75rem; cursor:pointer; width:100%; transition: background 0.2s;">
                    ➕ 新增自訂站碼規則
                </button>
            </div>
        `;
    }
    else {
        const options = getOptionsByFilterId(filterId);
        checkboxesHtml += `<div style="display:grid; grid-template-columns: repeat(2, 1fr); gap:6px; padding:8px 0;" id="${zoneType}-options-${filterId}">`;
        options.forEach(opt => {
            const displayValues = opt.text || opt.value || '';
            const inputVal = opt.value !== undefined ? opt.value : opt.text;
            const hintHtml = opt.hint ? `<span style="font-size:0.75rem; color:#94a3b8; margin-left:4px;">${opt.hint}</span>` : '';

            checkboxesHtml += `
                <label style="font-size:0.85rem; display:flex; align-items:center; gap:4px; cursor:pointer;">
                    <input type="checkbox" value="${inputVal}" data-text="${displayValues}" onchange="onCheckboxChange('${zoneType}', '${filterId}')">
                    ${displayValues} ${hintHtml}
                </label>
            `;
        });
        checkboxesHtml += `</div>`;
    }

    groupDiv.innerHTML = checkboxesHtml;
    
    const firstGroup = zone.querySelector('.active-filter-group');
    if (firstGroup) {
        zone.insertBefore(groupDiv, firstGroup);
    } else {
        zone.appendChild(groupDiv);
    }

    if (filterId === 'town') handleTownSelect連動(zoneType);
    if (filterId === 'relay-station') handleRelaySelect連動(zoneType);
}

function getOptionsByFilterId(id) {
    if (id === 'city') {
        const cityEntries = Object.entries(rawData.mappings.city);
        cityEntries.sort((a, b) => cityOrder(a[1]) - cityOrder(b[1]));
        return cityEntries.map(([k,v]) => ({value: k, text: v}));
    }
    if (id === 'town') {
        // 🐛 修正：選項改為「縣市-鄉鎮」組合（值 = 縣市代碼-鄉鎮代碼），同名區會分開列出並註明縣市
        const pairs = new Map();
        stationsArray.forEach(s => {
            if (s.town === undefined || s.town === null || s.town === '' || !s.city) return;
            const key = townPairKey(s.city, s.town);
            if (!pairs.has(key)) pairs.set(key, { city: s.city, town: s.town });
        });
        const nameCount = {};
        pairs.forEach(p => {
            const n = rawData.mappings.town[p.town] || String(p.town);
            nameCount[n] = (nameCount[n] || 0) + 1;
        });
        const list = [...pairs.entries()].map(([key, p]) => {
            const townName = rawData.mappings.town[p.town] || String(p.town);
            const cityName = rawData.mappings.city[p.city] || '';
            return {
                value: key,
                text: nameCount[townName] > 1 ? `${townName}（${cityName}）` : townName,
                _city: cityName, _town: townName
            };
        });
        list.sort((a, b) => (cityOrder(a._city) - cityOrder(b._city)) || a._town.localeCompare(b._town, 'zh-Hant'));
        return list.map(({ value, text }) => ({ value, text }));
    }
    
    if (id === 'station_type') {
        if (rawData.mappings && rawData.mappings.station_type) {
            return Object.entries(rawData.mappings.station_type).map(([k, v]) => ({ value: k, text: v }));
        }
        return [];
    }
    if (id === 'regional-center') {
        return [8,9,10,11,12,13,14,15,16,17,18,19].map(k => ({value: k, text: rawData.mappings.reg[k]}));
    }
    if (id === 'relay-station') {
        const hubs = stationsArray.filter(s => s.is_hub === true);
        hubs.sort((a, b) => {
            const regA = parseInt(a.reg || 0);
            const regB = parseInt(b.reg || 0);
            if (regA !== regB) return regA - regB;
            return String(a.n).localeCompare(String(b.n), 'zh-Hant');
        });
        return hubs.map(h => ({ value: h.n, text: h.n }));
    }
    if (id === 'unit') return [...new Set(stationsArray.map(s => s._derivedUnit))].map(v => ({value: v, text: v}));
    if (id === 'transport') return ['無線電', '4G', '實體網路', '外單位雨量資料交換'].map(v => ({value: v, text: v}));
    if (id === 'weather-freq') return ['1分鐘', '10分鐘'].map(v => ({value: v, text: v}));
    if (id === 'rain-freq') return ['1分鐘', '10分鐘'].map(v => ({value: v, text: v}));
    if (id === 'vendor') return [...new Set(stationsArray.map(s => s._derivedVendor))].filter(v => v !== "未知").map(v => ({value: v, text: v}));
    
    if (id === 'status') {
        return [
            {value: '正式上架', text: '正式上架'}, 
            {value: '未上架', text: '未上架', hint: '(依據資料庫站點屬性)'}
        ];
    }
    if (id === 'public') {
        return [
            {value: '官網', text: '🌐 官網展示'},
            {value: 'PDS', text: 'PDS 系統(建置中)'},
            {value: '申購', text: '💰 資料申購(CODiS)'},
            {value: 'O-A0001', text: ' O-A0001 (逐時氣象)'},
            {value: 'O-A0002', text: ' O-A0002 (雨量)'},
            {value: 'O-A0003', text: ' O-A0003 (10分鐘綜觀)'},
            {value: 'O-A0005', text: ' O-A0005 (每日最大紫外線)'},
            {value: 'O-A0091', text: ' O-A0091 (日射量)'}
        ];
    }
    return [];
}

function getTitleByFilterId(id) {
    const titles = { 
        unit: '所屬單位', transport: '傳輸方式', city: '縣市', town: '鄉鎮市區', 
        'weather-freq': '氣象頻率', 'rain-freq': '雨量頻率', vendor: '維護廠商', 
        public: '對外供應狀態', station_type: '測站類型', 
        'regional-center': '區域站歸屬', 
        'relay-station': '中繼站選擇', 
        status: '上架狀態', 
        altitude: '海拔高度',
        'station-code-rule': '站碼規則'
    };
    return titles[id] || id;
}

function onCheckboxChange(zoneType, filterId) {
    const container = document.getElementById(`${zoneType}-options-${filterId}`);
    const checkedValues = Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value);
    
    if (checkedValues.length > 0) {
        activeFilters[zoneType][filterId] = checkedValues;
    } else {
        delete activeFilters[zoneType][filterId];
    }

    if (filterId === 'city') handleTownSelect連動(zoneType);
    if (filterId === 'regional-center') handleRelaySelect連動(zoneType); 
    calculateStations();
}

function onAltitudeInputChange(zoneType) {
    const container = document.getElementById(`${zoneType}-altitude-rows`);
    if (!container) return;

    const rows = container.querySelectorAll('.altitude-row');
    const ranges = [];

    rows.forEach(row => {
        const minVal = row.querySelector('.alt-min').value;
        const maxVal = row.querySelector('.alt-max').value;

        if (minVal !== "" || maxVal !== "") {
            const min = minVal !== "" ? parseFloat(minVal) : -Infinity;
            const max = maxVal !== "" ? parseFloat(maxVal) : Infinity;
            ranges.push([min, max]); 
        }
    });

    if (ranges.length > 0) {
        activeFilters[zoneType]['altitude'] = ranges; 
    } else {
        delete activeFilters[zoneType]['altitude']; 
    }
    calculateStations();
}

function addAltitudeRow(zoneType) {
    const container = document.getElementById(`${zoneType}-altitude-rows`);
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'altitude-row';
    row.style.display = 'flex'; row.style.alignItems = 'center'; row.style.gap = '6px'; row.style.marginTop = '4px';

    row.innerHTML = `
        <input type="number" class="alt-min" placeholder="最低(m)" min="0" max="4000" style="width: 75px; padding: 6px; background:#1e293b; border: 1px solid #475569; border-radius: 6px; color:white; font-size:0.85rem;" oninput="onAltitudeInputChange('${zoneType}')">
        <span style="color:#94a3b8;">~</span>
        <input type="number" class="alt-max" placeholder="最高(m)" min="0" max="4000" style="width: 75px; padding: 6px; background:#1e293b; border: 1px solid #475569; border-radius: 6px; color:white; font-size:0.85rem;" oninput="onAltitudeInputChange('${zoneType}')">
        <span style="font-size: 0.8rem; color: #94a3b8;">m</span>
        <button type="button" onclick="this.parentElement.remove(); onAltitudeInputChange('${zoneType}');" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:0.8rem; padding:0 4px;">❌</button>
    `;
    container.appendChild(row);
}

function removeFilterGroup(zoneType, filterId) {
    const el = document.getElementById(`${zoneType}-group-${filterId}`);
    if (el) el.remove();
    delete activeFilters[zoneType][filterId];
    if (filterId === 'city') handleTownSelect連動(zoneType);
    if (filterId === 'regional-center') handleRelaySelect連動(zoneType); 
    calculateStations();
}

function handleTownSelect連動(zoneType) {
    const townContainer = document.getElementById(`${zoneType}-options-town`);
    if (!townContainer) return;

    const selectedCities = activeFilters[zoneType]['city'] || [];
    const labels = townContainer.querySelectorAll('label');
    let needUpdate = false;

    labels.forEach(label => {
        const checkbox = label.querySelector('input');
        const cityCode = String(checkbox.value || "").split('-')[0];   // 值為「縣市代碼-鄉鎮代碼」
        
        if (selectedCities.length === 0) {
            label.style.display = 'flex';
        } else {
            const isMatch = selectedCities.includes(cityCode);
            if (isMatch) {
                label.style.display = 'flex';
            } else {
                label.style.display = 'none';
                if (checkbox.checked) {
                    checkbox.checked = false;
                    needUpdate = true;
                }
            }
        }
    });

    if (needUpdate) {
        const checkedValues = Array.from(townContainer.querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value);
        if (checkedValues.length > 0) {
            activeFilters[zoneType]['town'] = checkedValues;
        } else {
            delete activeFilters[zoneType]['town'];
        }
    }
}

function handleRelaySelect連動(zoneType) {
    const relayContainer = document.getElementById(`${zoneType}-options-relay-station`);
    if (!relayContainer) return;

    const selectedRegs = activeFilters[zoneType]['regional-center'] || [];
    const labels = relayContainer.querySelectorAll('label');
    let needUpdate = false;

    labels.forEach(label => {
        const checkbox = label.querySelector('input');
        const relayName = checkbox.value;
        const relayStation = stationsArray.find(s => s.n === relayName && s.is_hub === true);
        
        if (selectedRegs.length === 0) {
            label.style.display = 'flex'; 
        } else {
            if (relayStation && selectedRegs.includes(String(relayStation.reg || ""))) {
                label.style.display = 'flex';
            } else {
                label.style.display = 'none'; 
                if (checkbox.checked) {
                    checkbox.checked = false; 
                    needUpdate = true;
                }
            }
        }
    });

    if (needUpdate) {
        const checkedValues = Array.from(relayContainer.querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value);
        if (checkedValues.length > 0) {
            activeFilters[zoneType]['relay-station'] = checkedValues;
        } else {
            delete activeFilters[zoneType]['relay-station'];
        }
    }
}

// ==========================================================================
// 🔎 單一測站是否符合某張條件卡片（包含池與排除池共用）
//    回傳 true / false；null 代表此卡片沒有有效條件（例如站碼規則尚未填寫）
// ==========================================================================
function stationMatchesFilter(station, filterId, values) {
    switch (filterId) {
        case 'altitude': {
            const stationAlt = station.alt !== undefined && station.alt !== null ? parseFloat(station.alt) : 0;
            return values.some(range => stationAlt >= range[0] && stationAlt <= range[1]);
        }
        case 'station-code-rule': return matchStationCodeRule(station, values);
        case 'city': return values.includes(String(station.city || ""));
        case 'town': return values.includes(townPairKey(station.city, station.town));
        case 'station_type': return values.includes(String(station.station_type || ""));
        case 'regional-center':
            return values.includes(String(station.reg || "")) || values.some(v => String(rawData.mappings.reg[v]) === station._my_regional_boss);
        case 'relay-station': return values.some(v => (station._upstream_relay_names || []).includes(v));
        case 'unit': return values.includes(station._derivedUnit || "");
        case 'transport': return values.includes(station._derivedTransport || "");
        case 'weather-freq': return values.includes(station._derivedWeatherFreq || "");
        case 'rain-freq': return values.includes(station._derivedRainFreq || "");
        case 'vendor': return values.includes(station._derivedVendor || "");
        case 'status': return values.includes(station._derivedStatus || "");
        case 'public': {
            const channels = station.supply_channels || [];
            return values.some(v => channels.includes(v));
        }
        default: return null;
    }
}

function matchStationCodeRule(station, values) {
    const hasQuick = values.quick && values.quick.length > 0;
    const hasCustom = values.custom && values.custom.length > 0;
    if (!hasQuick && !hasCustom) return null;

    const idStr = String(station.cwbid || station.sid || "").toUpperCase();
    const results = [];
    if (hasQuick) {
        if (values.quick.includes('46start')) results.push(idStr.startsWith('46'));
        if (values.quick.includes('2nd_2')) results.push(idStr.charAt(1) === '2');
    }
    if (hasCustom) {
        values.custom.forEach(rule => {
            if (rule.type === 'prefix') results.push(idStr.startsWith(String(rule.value).toUpperCase()));
            else if (rule.type === 'position') results.push(idStr.charAt(rule.pos - 1) === String(rule.char).toUpperCase());
        });
    }
    return values.logic === 'and' ? results.every(r => r) : results.some(r => r);
}

function calculateStations() {
    if (!stationsArray.length || isRestoringState) return;

    const hasTypeInInclude = activeFilters.include['station_type'] !== undefined;
    const hasTypeInExclude = activeFilters.exclude['station_type'] !== undefined;

    let filteredResults = stationsArray.filter(station => {
        if (hasTypeInInclude || hasTypeInExclude) return true; 
        return station.is_hub !== true && station.is_reg_center !== true;
    });

    // 包含池：每張卡片都要符合（跨卡片 AND）；卡片內勾選多個為 OR（判斷寫在 stationMatchesFilter）
    Object.entries(activeFilters.include).forEach(([filterId, values]) => {
        filteredResults = filteredResults.filter(station => {
            const r = stationMatchesFilter(station, filterId, values);
            return r === null ? true : r;      // null = 此卡片沒有有效條件，不影響結果
        });
    });

    // 排除池：符合任一張卡片就扣除
    Object.entries(activeFilters.exclude).forEach(([filterId, values]) => {
        filteredResults = filteredResults.filter(station => {
            const r = stationMatchesFilter(station, filterId, values);
            return r === null ? true : !r;
        });
    });

    if (manualExcludedSids.length > 0) {
        const excludedSet = new Set(manualExcludedSids);
        filteredResults = filteredResults.filter(s => !excludedSet.has(s.sid));
    }

    // 🆕 保留使用者目前的排序（原本每次篩選都會重設）
    sortStationList(filteredResults);

    // 🆕 勾選狀態只保留仍在清單中的測站
    const visibleSids = new Set(filteredResults.map(s => String(s.sid)));
    checkedSids.forEach(sid => { if (!visibleSids.has(sid)) checkedSids.delete(sid); });

    currentFilteredList = filteredResults;

    const totalElement = document.getElementById('total-stations');
    if (totalElement) totalElement.innerText = filteredResults.length;

    renderTable(filteredResults);
    updateActiveFiltersSummary(); 
    syncQueryURL();   // 🆕 目前條件寫入網址，可直接分享
}

function renderTable(list) {
    const tbody = document.getElementById('station-table-body');
    if (!tbody) return;

    const selectAllCheckbox = document.getElementById('select-all-checkbox');
    if (selectAllCheckbox) selectAllCheckbox.checked = list.length > 0 && list.every(s => checkedSids.has(String(s.sid)));

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #ef4444;">無符合目前組合條件的測站</td></tr>`;
        return;
    }

    let html = "";
    list.forEach(s => {
        const cityName = rawData.mappings.city[s.city] || "未知";
        const townName = rawData.mappings.town[s.town] || s.town || "無";
        
        const reasonAttr = s.publish_reason ? `title="暫不上架原因：${s.publish_reason}"` : "";
        // 判斷狀態：若為未上架，有 cwbid 則顯示 cwbid(sid)，否則僅顯示 sid，並維持灰色樣式
        // 判斷狀態：若為未上架，有 cwbid 則顯示 cwbid(sid)；若無 cwbid，則顯示 未知(sid)，皆維持灰色樣式
        const displayCwbid = (s._derivedStatus === "未上架") 
            ? `<span style="color:#94a3b8; font-style:italic; cursor:help;" ${reasonAttr}>${s.cwbid ? `${s.cwbid} <small>(${s.sid})</small>` : `未知 <small>(${s.sid})</small>`}</span>` 
            : `<strong>${s.cwbid || '未知'}</strong> <small>(${s.sid})</small>`;

        const displayAlt = (s.alt !== undefined && s.alt !== null) ? `${s.alt} 公尺` : "-";
        
        html += `
            <tr class="clickable-row" data-sid="${s.sid}" style="cursor: pointer;" title="點擊在地圖上定位此測站">
                <td style="text-align: center;" onclick="event.stopPropagation();">
                    <input type="checkbox" class="row-checkbox" data-sid="${s.sid}" style="cursor: pointer; transform: scale(1.2);" ${checkedSids.has(String(s.sid)) ? 'checked' : ''}>
                </td>
                <td>${displayCwbid}</td>
                <td>${s.n}</td>
                <td>${cityName}</td>
                <td>${townName}</td>
                <td><span style="font-size:0.8rem; background:#334155; padding:2px 6px; border-radius:4px; color:#38bdf8;">${displayAlt}</span></td>
            </tr>`;
    });
    tbody.innerHTML = html;

    tbody.querySelectorAll('.clickable-row').forEach(row => {
        row.addEventListener('click', () => {
            const sid = row.getAttribute('data-sid');
            const target = stationsArray.find(s => String(s.sid) === String(sid));
            if (target) focusStationOnMap(target);
        });
    });
}

function exportToCSV() {
    if (currentFilteredList.length === 0) {
        alert("目前沒有符合條件的測站資料可以匯出！");
        return;
    }
    // 🆕 前幾列記錄查詢條件與資料日期，日後翻閱時能知道這份清單怎麼來的
    const meta = [
        `${csvCell('查詢條件')},${csvCell(describeFiltersText())}`,
        `${csvCell('匯出時間')},${csvCell(formatDateTime(new Date()))}`,
        `${csvCell('資料更新時間')},${csvCell(dataUpdatedText())}`,
        `${csvCell('測站數')},${csvCell(currentFilteredList.length)}`,
        ''
    ];
    const headers = [
        "原始站碼(sid)", "正式代碼(cwbid)", "站名", "縣市", "鄉鎮市區",
        "緯度(lat)", "經度(lon)", "高度(alt)", "傳輸方式", "所屬單位", "維護廠商",
        // 🆕 補充欄位
        "測站類型", "區域站歸屬", "直屬中繼站", "上架狀態", "未上架原因", "資料供應管道"
    ];
    const rows = currentFilteredList.map(s => {
        const cityName = rawData.mappings.city[s.city] || "未知";
        const townName = rawData.mappings.town[s.town] || s.town || "無";
        const latValue = (s.lat !== undefined && s.lat !== null) ? s.lat : "";
        const lonValue = (s.lon !== undefined && s.lon !== null) ? s.lon : "";
        return [
            s.sid, s.cwbid || "", s.n, cityName, townName,
            latValue, lonValue, (s.alt !== undefined && s.alt !== null) ? s.alt : "",
            s._derivedTransport, s._derivedUnit, s._derivedVendor,
            rawData.mappings.station_type[s.station_type] || "",
            regionalNameOf(s),
            (s._upstream_relay_names && s._upstream_relay_names[0]) || "",
            s._derivedStatus,
            s.publish_reason || "",
            (s.supply_channels || []).join("、")
        ].map(csvCell).join(",");
    });
    downloadCSV([...meta, headers.map(csvCell).join(","), ...rows], `測站篩選結果匯出_${new Date().toISOString().slice(0,10)}.csv`);
}

function initSubPanelResizer() {
    const resizer = document.getElementById('sub-panel-resizer');
    const counterCard = document.getElementById('top-counter-card');
    if (!resizer || !counterCard) return;

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        resizer.classList.add('resizing');
        const startY = e.clientY;
        const startHeight = counterCard.offsetHeight;

        const onMouseMove = (moveEvent) => {
            const deltaY = moveEvent.clientY - startY;
            const newHeight = startHeight + deltaY;
            
            if (newHeight >= 70 && newHeight <= 200) {
                counterCard.style.height = `${newHeight}px`;
                counterCard.style.padding = newHeight < 90 ? '8px 24px' : '12px 24px';
                const numEl = counterCard.querySelector('.counter-number');
                if (numEl) {
                    numEl.style.fontSize = newHeight < 90 ? '2rem' : '2.5rem';
                }
            }
        };

        const onMouseUp = () => {
            resizer.classList.remove('resizing');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

function initModalResizer() {
    const resizer = document.getElementById('modal-resizer');
    const modalContent = document.querySelector('.modal-content');
    const mapContainer = document.getElementById('map-container');
    if (!resizer || !modalContent || !mapContainer) return;

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault(); 
        resizer.style.background = 'linear-gradient(135deg, transparent 50%, #0284c7 50%)';
        mapContainer.style.pointerEvents = 'none'; 

        const rect = modalContent.getBoundingClientRect();
        modalContent.style.position = 'fixed';
        modalContent.style.top = rect.top + 'px';
        modalContent.style.left = rect.left + 'px';
        modalContent.style.margin = '0';
        modalContent.style.transform = 'none'; 

        const startWidth = rect.width;
        const startHeight = rect.height;
        const startX = e.clientX;
        const startY = e.clientY;

        let resizeAnimationFrame; 

        const onMouseMove = (moveEvent) => {
            const deltaX = moveEvent.clientX - startX;
            const deltaY = moveEvent.clientY - startY;
            const newWidth = startWidth + deltaX;
            const newHeight = startHeight + deltaY;

            if (newWidth >= 450 && newWidth <= window.innerWidth * 0.95) modalContent.style.width = `${newWidth}px`;
            if (newHeight >= 400 && newHeight <= window.innerHeight * 0.95) modalContent.style.height = `${newHeight}px`;

            if (resizeAnimationFrame) cancelAnimationFrame(resizeAnimationFrame);
            resizeAnimationFrame = requestAnimationFrame(() => {
                if (mapInstance) mapInstance.invalidateSize();
            });
        };

        const onMouseUp = () => {
            resizer.style.background = ''; 
            mapContainer.style.pointerEvents = 'auto'; 
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            if (resizeAnimationFrame) cancelAnimationFrame(resizeAnimationFrame);
            if (mapInstance) mapInstance.invalidateSize();
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

// ==========================================================================
// 🗺️ 渲染測站分布地圖 (方案 B：多維度複合著色 - 邏輯修正完全體)
// ==========================================================================
function renderMap() {
    const mapContainer = document.getElementById('map-container');
    if (!mapContainer) return;

    function getRadiusByZoom(zoom) {
        if (zoom <= 7) return 2.5; 
        if (zoom === 8) return 4;
        if (zoom === 9) return 5;
        if (zoom === 10) return 7;
        if (zoom === 11) return 9;
        return 12;                 
    }

    const colorPalette = [
        { stroke: "#0284c7", fill: "#38bdf8" }, 
        { stroke: "#16a34a", fill: "#4ade80" }, 
        { stroke: "#d97706", fill: "#fbbf24" }, 
        { stroke: "#9333ea", fill: "#c084fc" }, 
        { stroke: "#e11d48", fill: "#fb7185" }, 
        { stroke: "#0d9488", fill: "#2dd4bf" }, 
        { stroke: "#ea580c", fill: "#ffedd5" },
        { stroke: "#6366f1", fill: "#a5b4fc" }, 
        { stroke: "#ec4899", fill: "#f9a8d4" },
        { stroke: "#f43f5e", fill: "#fda4af" }
    ];

    // 🐛 修正：色盤只有 10 色，超過的類別原本會輪替重複；現在統一歸為「其他」並在圖例註明
    const OTHER_COLOR = { stroke: "#334155", fill: "#94a3b8" };
    const colorAt = (index) => index < colorPalette.length ? colorPalette[index] : OTHER_COLOR;

    const activeIncludeKeys = Object.keys(activeFilters.include);
    let valueColorMap = {};
    let legendItems = []; 
    let compositeMode = "none"; 
    let primaryKey = null; 

    let targetValues = [];
    let legendTitle = "觀測站點";

    if (activeIncludeKeys.includes('city') && activeIncludeKeys.includes('town')) {
        compositeMode = "geo";
        legendTitle = "縣市-鄉鎮";
        const selectedTowns = activeFilters.include['town'] || [];
        selectedTowns.forEach(tKey => targetValues.push(townGeoKey(tKey)));
    } else if (activeIncludeKeys.includes('regional-center') && activeIncludeKeys.includes('relay-station')) {
        compositeMode = "relay";
        legendTitle = "區域-中繼";
        const selectedRelays = activeFilters.include['relay-station'] || [];
        selectedRelays.forEach(rName => {
            const regCode = stationsArray.find(s => s.n === rName && (s.is_hub === true || String(s.is_hub) === "1"))?.reg;
            const regName = rawData.mappings.reg[regCode] || "未知中心";
            targetValues.push(`${regName}-${rName}`);
        });
    } else if (activeIncludeKeys.length > 0) {
        compositeMode = "single";
        primaryKey = activeIncludeKeys[0];
        legendTitle = getTitleByFilterId(primaryKey);
        targetValues = activeFilters.include[primaryKey] || [];
    }

    if (compositeMode !== "none" && primaryKey !== 'altitude') {
        try {
            const uniqueValues = [...new Set(targetValues)];
            uniqueValues.forEach((val, index) => {
                const colorObj = colorAt(index);
                valueColorMap[val] = colorObj;
                if (index >= colorPalette.length) return;   // 超出色盤者統一歸「其他」

                let displayTxt = val;
                if (compositeMode === "single") {
                    if (primaryKey === 'city') displayTxt = rawData.mappings.city[val] || val;
                    else if (primaryKey === 'town') displayTxt = townLabel(val);
                    else if (primaryKey === 'station_type') displayTxt = rawData.mappings.station_type[val] || val;
                    else if (primaryKey === 'regional-center') displayTxt = rawData.mappings.reg[val] || val;
                    else if (primaryKey === 'public') {
                        const opt = getOptionsByFilterId('public').find(o => String(o.value) === String(val));
                        displayTxt = opt ? opt.text.replace(/🌐|💰| |└/g, '') : val;
                    }
                }
                legendItems.push({ color: colorObj.stroke, label: `${legendTitle}：${displayTxt}` });
            });
            if (uniqueValues.length > colorPalette.length) {
                legendItems.push({ color: OTHER_COLOR.stroke, label: `其他 ${uniqueValues.length - colorPalette.length} 類（共用此色；類別過多，建議分次查看）` });
            }
        } catch (e) {
            console.error("圖例生成失敗:", e);
        }
    } else if (primaryKey === 'altitude') {
        const ranges = activeFilters.include['altitude'] || [];
        ranges.forEach((range, index) => {
            if (index >= colorPalette.length) return;
            const colorObj = colorAt(index);
            const minTxt = range[0] === -Infinity ? "0" : range[0];
            const displayTxt = range[1] === Infinity ? `${minTxt} m 以上` : `${minTxt} ~ ${range[1]} m`;
            legendItems.push({ color: colorObj.stroke, label: `海拔高度：${displayTxt}` });
        });
        if (ranges.length > colorPalette.length) {
            legendItems.push({ color: OTHER_COLOR.stroke, label: `其他 ${ranges.length - colorPalette.length} 個高度區間（共用此色）` });
        }
    } else {
        legendItems.push({ color: "#0284c7", label: "觀測站點" });
    }

    function getStationColorKey(s) {
        if (compositeMode === "geo") {
            const cName = rawData.mappings.city[s.city] || "未知";
            const tName = rawData.mappings.town[s.town] || "未知";
            return `${cName}-${tName}`;
        }
        if (compositeMode === "relay") {
            const selectedRelays = activeFilters.include['relay-station'] || [];
            const activeParent = (s._upstream_relay_names || []).find(name => selectedRelays.includes(name));
            if (activeParent) {
                const regName = rawData.mappings.reg[s.reg] || "未知中心";
                return `${regName}-${activeParent}`;
            }
            return "unknown";
        }
        if (compositeMode === "single") {
            if (primaryKey === 'unit') return s._derivedUnit || "";
            if (primaryKey === 'transport') return s._derivedTransport || "";
            if (primaryKey === 'city') return String(s.city || "");
            if (primaryKey === 'town') return townPairKey(s.city, s.town);
            if (primaryKey === 'weather-freq') return s._derivedWeatherFreq || "";
            if (primaryKey === 'rain-freq') return s._derivedRainFreq || "";
            if (primaryKey === 'vendor') return s._derivedVendor || "";
            if (primaryKey === 'status') return s._derivedStatus || "";
            if (primaryKey === 'station_type') return String(s.station_type || "");
            if (primaryKey === 'regional-center') return String(s.reg || "");
            if (primaryKey === 'public') {
                const publicFilters = activeFilters.include['public'] || [];
                return publicFilters.find(v => (s.supply_channels || []).includes(v)) || "";
            }
            // 💡 新增這段：當使用者單純只選「中繼站選擇」卡片時，點點也要能正確依中繼站名稱抓取顏色 Key
            if (primaryKey === 'relay-station') {
                const relayFilters = activeFilters.include['relay-station'] || [];
                return relayFilters.find(v => (s._upstream_relay_names || []).includes(v)) || "none";
            }
        }
        return "none";
    }

    function getMatchValueChineseName(s, rawVal) {
        if (compositeMode === "geo" || compositeMode === "relay") return rawVal; 
        if (compositeMode === "single") {
            if (primaryKey === 'city') return rawData.mappings.city[rawVal] || rawVal;
            if (primaryKey === 'town') return townLabel(rawVal);
            if (primaryKey === 'station_type') return rawData.mappings.station_type[rawVal] || rawVal;
            if (primaryKey === 'regional-center') return rawData.mappings.reg[rawVal] || rawVal;
            if (primaryKey === 'public') {
                const opt = getOptionsByFilterId('public').find(o => String(o.value) === String(rawVal));
                return opt ? opt.text.replace(/🌐|💰| |└/g, '') : rawVal;
            }
            // 💡 新增這段：讓單選中繼站時，泡泡提示也能完美秀出中繼站名稱
            if (primaryKey === 'relay-station') {
                return rawVal; 
            }
        }
        return rawVal;
    }

    if (!mapInstance) {
        mapContainer.innerHTML = '';
        mapInstance = L.map('map-container', { zoomControl: true, attributionControl: false, preferCanvas: true }).setView([23.7, 120.9], 7);

        if (taiwanGeoData) {
            L.geoJSON(taiwanGeoData, { style: { color: "#cbd5e1", weight: 1.5, fillColor: "#f8fafc", fillOpacity: 1 } }).addTo(mapInstance);
        }

        mapInstance.on('zoomend', () => {
            if (!markersLayer) return;
            const currentZoom = mapInstance.getZoom();
            const newRadius = getRadiusByZoom(currentZoom);
            markersLayer.eachLayer(marker => { if (typeof marker.setRadius === 'function') marker.setRadius(newRadius); });
        });
    }

    if (mapInstance.legendControl) mapInstance.removeControl(mapInstance.legendControl);
    mapInstance.legendControl = L.control({ position: 'bottomright' }); 
    mapInstance.legendControl.onAdd = function () {
        const div = L.DomUtil.create('div', 'map-legend');
        div.style.background = '#ffffff'; div.style.padding = '12px 16px'; div.style.borderRadius = '8px';
        div.style.boxShadow = '0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)';
        div.style.border = '1px solid #e2e8f0'; div.style.color = '#0f172a'; div.style.fontSize = '0.75rem'; 
        div.style.fontFamily = 'inherit'; div.style.lineHeight = '1.5'; div.style.maxWidth = '420px';

        let html = `<h4 style="margin: 0 0 8px 0; font-size: 0.8rem; border-bottom: 2px solid #cbd5e1; padding-bottom: 4px; color: #1e293b; font-weight:bold;">🗺️ 目前地圖圖例</h4>`;
        const useGrid = legendItems.length > 5;
        html += useGrid ? `<div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 16px;">` : `<div style="display: flex; flex-direction: column; gap: 4px;">`;
        legendItems.forEach(item => {
            html += `<div style="display: flex; align-items: center; gap: 6px; white-space: nowrap;"><span style="flex-shrink:0; display: inline-block; width: 8px; height: 8px; background-color: ${item.color}; border-radius: 50%; border: 1px solid rgba(0,0,0,0.15);"></span><span style="font-weight: 500; color: #334155;">${item.label}</span></div>`;
        });
        html += `</div>`; div.innerHTML = html; return div;
    };
    mapInstance.legendControl.addTo(mapInstance);

    if (markersLayer) mapInstance.removeLayer(markersLayer);
    markersLayer = L.featureGroup().addTo(mapInstance);

    markerDict = {}; 

    const initZoom = mapInstance.getZoom();
    const initRadius = getRadiusByZoom(initZoom);

    const listToRender = (isSearchMode && searchTargetStation) ? [searchTargetStation] : currentFilteredList;

    listToRender.forEach(s => {
        try {
            if (s.lat && s.lon) {
                let dotColor = "#0284c7"; let fillColor = "#38bdf8"; let matchValueName = "";

                if (activeIncludeKeys.length > 0) {
                    const checkKey = compositeMode === "single" ? primaryKey : activeIncludeKeys[0];
                    if (checkKey === 'altitude') {
                        const stationAlt = s.alt !== undefined && s.alt !== null ? parseFloat(s.alt) : 0;
                        const chosenRanges = activeFilters.include['altitude'] || [];
                        const matchedIdx = chosenRanges.findIndex(r => stationAlt >= r[0] && stationAlt <= r[1]);
                        
                        if (matchedIdx !== -1) {
                            const colorObj = colorAt(matchedIdx);
                            dotColor = colorObj.stroke; fillColor = colorObj.fill;
                            const r = chosenRanges[matchedIdx];
                            const minTxt = r[0] === -Infinity ? "0" : r[0];
                            matchValueName = r[1] === Infinity ? `${minTxt} m 以上` : `${minTxt} ~ ${r[1]} m`;
                        } else {
                            dotColor = "#64748b"; fillColor = "#cbd5e1";
                        }
                    } else {
                        let stationValue = getStationColorKey(s);
                        matchValueName = getMatchValueChineseName(s, stationValue); 

                        if (valueColorMap[stationValue]) {
                            dotColor = valueColorMap[stationValue].stroke; 
                            fillColor = valueColorMap[stationValue].fill;
                        } else {
                            dotColor = "#64748b"; 
                            fillColor = "#cbd5e1";
                        }
                    }
                }

                const marker = L.circleMarker([s.lat, s.lon], { radius: initRadius, color: dotColor, weight: 1.5, fillColor: fillColor, fillOpacity: 0.85 });

                let badgeHtml = "";
                if (activeIncludeKeys.length > 0 && matchValueName) {
                    const labelTitle = legendTitle;
                    badgeHtml = `<div style="margin-top: 4px; font-size: 0.75rem; background: ${dotColor}1a; color: ${dotColor}; border: 1px solid ${dotColor}40; padding: 1px 6px; border-radius: 4px; display: inline-block;">${labelTitle}：${matchValueName}</div>`;
                }

                let reasonHtml = "";
                if (s._derivedStatus === "未上架" && s.publish_reason) {
                    reasonHtml = `<div style="margin-top: 4px; font-size: 0.75rem; background: #fef2f2; color: #ef4444; border: 1px solid #fecaca; padding: 2px 6px; border-radius: 4px; display: inline-block;">🚧 暫不上架：${s.publish_reason}</div>`;
                }

                marker.bindTooltip(`<div style="text-align:center;"><span style="color:#64748b; font-size:0.75rem;">${s.cwbid || s.sid}</span><br><strong style="font-size:1rem; color:#0f172a;">${s.n}</strong><br>${badgeHtml}<br>${reasonHtml}</div>`, {
                    direction: 'top', className: 'map-tooltip', offset: [0, -5]
                });

                marker.bindPopup(generateStationPopupHtml(s));

                markerDict[s.sid] = marker;
                markersLayer.addLayer(marker);
            }
        } catch (err) {
            console.error("繪製測站標記時發生錯誤:", s.sid, err);
        }
    });

    setTimeout(() => {
        if (!mapInstance) return;
        try {
            mapInstance.invalidateSize(); 
            
            if (listToRender.length > 0) {
                if (isSearchMode && searchTargetStation) {
                    mapInstance.setView([searchTargetStation.lat, searchTargetStation.lon], 12);
                    if (markerDict[searchTargetStation.sid]) {
                        setTimeout(() => markerDict[searchTargetStation.sid].openPopup(), 400);
                    }
                } else {
                    const boundsPoints = [];
                    listToRender.forEach(s => { 
                        if (s.lat && s.lon && parseFloat(s.lat) > 21.5) {
                            boundsPoints.push([parseFloat(s.lat), parseFloat(s.lon)]); 
                        }
                    });
                    
                    if (boundsPoints.length > 0) {
                        const bounds = L.latLngBounds(boundsPoints);
                        if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
                            mapInstance.setView(boundsPoints[0], 12);
                        } else {
                            mapInstance.fitBounds(bounds, { padding: [45, 45], maxZoom: 12 });
                        }
                    } else { 
                        const validS = listToRender.find(s => s.lat && s.lon);
                        if (validS) {
                            mapInstance.setView([validS.lat, validS.lon], 9);
                        } else {
                            mapInstance.setView([23.7, 120.9], 7);
                        }
                    }
                }
            } else { 
                mapInstance.setView([23.7, 120.9], 7); 
            }
        } catch (err) {
            console.error("地圖視角校正發生錯誤:", err);
            mapInstance.setView([23.7, 120.9], 7);
        }
    }, 360); 
}

// ==========================================================================
// 🧹 總控：一鍵重置所有篩選條件
// ==========================================================================
function initResetButton() {
    const resetBtn = document.getElementById('reset-filters-btn');
    if (!resetBtn) return;

    resetBtn.addEventListener('click', () => {
        if (!confirm("確定要清空目前所有的篩選條件嗎？")) return;

        activeFilters.include = {};
        activeFilters.exclude = {};
        manualExcludedSids = []; 
        checkedSids.clear();

        document.querySelectorAll('.active-filter-group').forEach(el => el.remove());
        initDefaultFilters();
        calculateStations();

        const mapModal = document.getElementById('map-modal');
        if (mapModal && mapModal.classList.contains('active')) {
            renderMap();
        }
    });
}

// ==========================================================================
// 🔃 表格點擊排序功能
// ==========================================================================
// 依 currentSort 排序（點標題與重新篩選時共用）
function sortStationList(list) {
    const column = currentSort.column;
    if (!column) return list;
    const getVal = (s) => {
        if (column === 'cwbid') return s.cwbid || s.sid || "";
        if (column === 'name') return s.n || "";
        if (column === 'city') return rawData.mappings.city[s.city] || "";
        if (column === 'town') return rawData.mappings.town[s.town] || s.town || "";
        if (column === 'alt') return s.alt !== undefined && s.alt !== null ? parseFloat(s.alt) : -Infinity;
        return "";
    };
    const dir = currentSort.direction === 'asc' ? 1 : -1;
    list.sort((a, b) => {
        const valA = getVal(a), valB = getVal(b);
        if (column === 'alt') return dir * ((valA > valB) - (valA < valB));
        return dir * String(valA).localeCompare(String(valB), 'zh-Hant');
    });
    return list;
}

function updateSortIcons() {
    document.querySelectorAll('#station-table th .sort-icon').forEach(icon => { icon.innerHTML = ""; });
    if (!currentSort.column) return;
    const activeHeaderIcon = document.querySelector(`#station-table th[data-sort="${currentSort.column}"] .sort-icon`);
    if (activeHeaderIcon) activeHeaderIcon.innerHTML = currentSort.direction === 'asc' ? ' 🔼' : ' 🔽';
}

function initTableSorting() {
    const headers = document.querySelectorAll('#station-table th[data-sort]');
    
    headers.forEach(header => {
        header.addEventListener('click', () => {
            const column = header.getAttribute('data-sort');
            if (currentFilteredList.length === 0) return;

            if (currentSort.column === column) {
                currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.column = column;
                currentSort.direction = 'asc';
            }

            sortStationList(currentFilteredList);
            updateSortIcons();
            renderTable(currentFilteredList);   // 勾選狀態由 checkedSids 保留
        });
    });
}

// ==========================================================================
// 🎯 共用功能：將地圖核心聚焦到指定測站並打開卡片
// ==========================================================================
function focusStationOnMap(targetStation) {
    if (!targetStation) return;
    
    if (!targetStation.lat || !targetStation.lon) {
        alert(`測站 [${targetStation.n}] 無座標資料無法定位！`);
        return;
    }

    isSearchMode = true;
    searchTargetStation = targetStation;

    const mapModal = document.getElementById('map-modal');
    if (mapModal && !mapModal.classList.contains('active')) {
        mapModal.classList.add('active');
    }
    
    renderMap(); 
}

// ==========================================================================
// 🧠 站碼多組規則：動態產生與動態切換輸入框
// ==========================================================================
function addStationCodeRuleRow(zoneType) {
    const container = document.getElementById(`${zoneType}-code-rule-rows`);
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'code-rule-row';
    row.style.display = 'flex'; row.style.alignItems = 'center'; row.style.gap = '6px'; row.style.marginTop = '4px';

    row.innerHTML = `
        <select class="rule-type" onchange="toggleRuleInputs(this, '${zoneType}')" style="padding: 4px 6px; background:#1e293b; border: 1px solid #475569; border-radius: 6px; color:white; font-size:0.85rem; outline:none;">
            <option value="prefix">開頭為</option>
            <option value="position">特定位置</option>
        </select>
        <div class="rule-inputs-container" style="display:flex; align-items:center; gap:4px; flex:1;">
            <input type="text" class="code-prefix" placeholder="如: 46" style="width: 80px; padding: 5px 8px; background:#1e293b; border: 1px solid #475569; border-radius: 6px; color:white; font-size:0.85rem;" oninput="onCodeRuleInputChange('${zoneType}')">
        </div>
        <button type="button" onclick="this.parentElement.remove(); onCodeRuleInputChange('${zoneType}');" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:0.85rem; padding:0 4px;" title="刪除此條件">❌</button>
    `;
    container.appendChild(row);
    onCodeRuleInputChange(zoneType);
}

function toggleRuleInputs(selectEl, zoneType) {
    const container = selectEl.parentElement.querySelector('.rule-inputs-container');
    if (!container) return;

    if (selectEl.value === 'prefix') {
        container.innerHTML = `
            <input type="text" class="code-prefix" placeholder="如: 46" style="width: 80px; padding: 5px 8px; background:#1e293b; border: 1px solid #475569; border-radius: 6px; color:white; font-size:0.85rem;" oninput="onCodeRuleInputChange('${zoneType}')">
        `;
    } else {
        container.innerHTML = `
            <span style="font-size:0.85rem; color:#94a3b8;">第</span>
            <input type="number" class="code-pos" placeholder="2" min="1" max="10" style="width: 45px; padding: 5px 2px; text-align:center; background:#1e293b; border: 1px solid #475569; border-radius: 6px; color:white; font-size:0.85rem;" oninput="onCodeRuleInputChange('${zoneType}')">
            <span style="font-size:0.85rem; color:#94a3b8;">碼為</span>
            <input type="text" class="code-char" placeholder="2" maxLength="1" style="width: 40px; padding: 5px 2px; text-align:center; background:#1e293b; border: 1px solid #475569; border-radius: 6px; color:white; font-size:0.85rem;" oninput="onCodeRuleInputChange('${zoneType}')">
        `;
    }
    onCodeRuleInputChange(zoneType);
}

function onCodeRuleInputChange(zoneType) {
    const groupDiv = document.getElementById(`${zoneType}-group-station-code-rule`);
    if (!groupDiv) return;

    const quickChecked = Array.from(groupDiv.querySelectorAll('.quick-rule:checked')).map(el => el.value);
    const rows = groupDiv.querySelectorAll('.code-rule-row');
    const customRules = [];

    rows.forEach(row => {
        const type = row.querySelector('.rule-type').value;
        if (type === 'prefix') {
            const prefixInput = row.querySelector('.code-prefix');
            const prefixVal = prefixInput ? prefixInput.value.trim() : "";
            if (prefixVal) customRules.push({ type: 'prefix', value: prefixVal });
        } else if (type === 'position') {
            const posInput = row.querySelector('.code-pos');
            const charInput = row.querySelector('.code-char');
            const posVal = posInput ? posInput.value.trim() : "";
            const charVal = charInput ? charInput.value.trim() : "";
            if (posVal && charVal) customRules.push({ type: 'position', pos: parseInt(posVal), char: charVal });
        }
    });

    const logicSelect = groupDiv.querySelector('.code-logic-select');
    const logicVal = logicSelect ? logicSelect.value : 'or';

    const ruleState = { logic: logicVal, quick: quickChecked, custom: customRules };

    if (quickChecked.length > 0 || customRules.length > 0) {
        activeFilters[zoneType]['station-code-rule'] = ruleState;
    } else {
        delete activeFilters[zoneType]['station-code-rule'];
    }

    calculateStations();
}

// ==========================================================================
// 🗑️ 批量剔除功能
// ==========================================================================
function initBatchDelete() {
    const batchDeleteBtn = document.getElementById('batch-delete-btn');
    const selectAllCheckbox = document.getElementById('select-all-checkbox');
    
    if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            document.querySelectorAll('.row-checkbox').forEach(cb => {
                cb.checked = isChecked;
                const sid = String(cb.getAttribute('data-sid'));
                if (isChecked) checkedSids.add(sid); else checkedSids.delete(sid);
            });
        });
    }

    // 🆕 記住每列的勾選狀態（排序、調整條件後仍保留）
    const tbody = document.getElementById('station-table-body');
    if (tbody) {
        tbody.addEventListener('change', (e) => {
            const cb = e.target.closest('.row-checkbox');
            if (!cb) return;
            const sid = String(cb.getAttribute('data-sid'));
            if (cb.checked) checkedSids.add(sid); else checkedSids.delete(sid);
            if (selectAllCheckbox) selectAllCheckbox.checked = currentFilteredList.length > 0 && currentFilteredList.every(s => checkedSids.has(String(s.sid)));
        });
    }

    if (batchDeleteBtn) {
        batchDeleteBtn.addEventListener('click', () => {
            const checkedBoxes = document.querySelectorAll('.row-checkbox:checked');
            if (checkedBoxes.length === 0) {
                alert("請先在表格前方勾選要剔除的測站！");
                return;
            }

            if (confirm(`確定要將選取的 ${checkedBoxes.length} 個測站從本次篩選中剔除嗎？\n(若要恢復，請點擊上方條件摘要中「手動剔除」標籤的「↩️ 復原」)`)) {
                checkedBoxes.forEach(cb => {
                    const sid = cb.getAttribute('data-sid');
                    if (!manualExcludedSids.includes(sid)) {
                        manualExcludedSids.push(sid);
                    }
                });
                
                checkedSids.clear();
                calculateStations(); 
                
                const mapModal = document.getElementById('map-modal');
                if (mapModal && mapModal.classList.contains('active')) {
                    renderMap();
                }
            }
        });
    }
}

// 🆕 單獨復原手動剔除的測站（不影響其他篩選條件）
function restoreManualExcluded() {
    const n = manualExcludedSids.length;
    if (n === 0) return;
    manualExcludedSids = [];
    calculateStations();
    const mapModal = document.getElementById('map-modal');
    if (mapModal && mapModal.classList.contains('active')) renderMap();
    showCalToast(`已復原 ${n} 個手動剔除的測站`);
}

// ==========================================================================
// ↕️ 過濾池上下拉伸調整功能
// ==========================================================================
function initZoneResizer() {
    const resizer = document.getElementById('zone-resizer');
    const includeZone = document.querySelector('.include-zone');
    const excludeZone = document.querySelector('.exclude-zone');
    const workspace = document.querySelector('.filter-workspace');

    if (!resizer || !includeZone || !excludeZone || !workspace) return;

    workspace.style.display = 'flex';
    workspace.style.flexDirection = 'column';

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        resizer.classList.add('resizing'); 

        const startY = e.clientY;
        const startHeight = includeZone.offsetHeight;

        const onMouseMove = (moveEvent) => {
            const deltaY = moveEvent.clientY - startY;
            const newHeight = startHeight + deltaY;

            if (newHeight >= 120 && newHeight <= workspace.offsetHeight - 150) {
                includeZone.style.flex = 'none'; 
                includeZone.style.height = `${newHeight}px`;
            }
        };

        const onMouseUp = () => {
            resizer.classList.remove('resizing'); 
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

// ==========================================================================
// 🏷️ 更新目前篩選條件標籤總覽 (Active Filters Summary)
// ==========================================================================
function updateActiveFiltersSummary() {
    const container = document.getElementById('active-filters-summary');
    if (!container) return;

    let html = '';

    const createTag = (zoneStr, title, valStr, color) => {
        return `<span style="background: ${color}1a; border: 1px solid ${color}40; color: ${color}; padding: 4px 8px; border-radius: 6px; font-size: 0.8rem; display: flex; align-items: center; gap: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
                    <strong style="opacity: 0.8;">${zoneStr} ${title}:</strong> ${valStr}
                </span>`;
    };

    const formatValues = formatFilterValues;   // 與 CSV、分組統計共用

    Object.entries(activeFilters.include).forEach(([filterId, values]) => {
        html += createTag('🟢 包含', getTitleByFilterId(filterId), formatValues(filterId, values), '#10b981');
    });

    Object.entries(activeFilters.exclude).forEach(([filterId, values]) => {
        html += createTag('🔴 排除', getTitleByFilterId(filterId), formatValues(filterId, values), '#ef4444');
    });

    if (manualExcludedSids.length > 0) {
        html += `<span style="background: #94a3b81a; border: 1px solid #94a3b840; color: #94a3b8; padding: 4px 8px; border-radius: 6px; font-size: 0.8rem; display: flex; align-items: center; gap: 6px; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
                    <strong style="opacity: 0.8;">🗑️ 手動剔除 自訂:</strong> 共隱藏 ${manualExcludedSids.length} 站
                    <button type="button" onclick="restoreManualExcluded()" title="復原所有手動剔除的測站（其他條件不變）" style="background:#334155; border:1px solid #475569; color:#e2e8f0; border-radius:4px; padding:1px 8px; font-size:0.75rem; cursor:pointer;">↩️ 復原</button>
                </span>`;
    }

    if (html === '') {
        container.innerHTML = '<span style="color: #64748b; font-size: 0.85rem; font-style: italic;">目前無任何篩選條件，顯示全臺測站</span>';
    } else {
        container.innerHTML = html;
    }
}

// ==========================================================================
// 🆕 v3 新增功能
//   1. 分組統計（單一維度／交叉表，可匯出）
//   2. 查詢條件存於網址（可分享）＋常用查詢
//   3. CSV 附查詢條件與資料日期、補充欄位（exportToCSV）
//   4. 資料更新時間
//   5. 資訊卡預留資料監控頁連結（MONITOR_PAGE_URL，目前未啟用）
//   6. 資料健檢
// ==========================================================================

function escHtml(v) {
    if (v === undefined || v === null) return '';
    return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function csvCell(v) { return `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`; }
function pad2(n) { return String(n).padStart(2, '0'); }
function formatDateTime(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function downloadCSV(lines, filename) {
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function openToolModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.add('active');
}
function closeToolModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove('active');
}

// --------------------------------------------------------------------------
// 共用：條件的文字描述（條件摘要、CSV、分組統計共用）
// --------------------------------------------------------------------------
function formatFilterValues(filterId, values) {
    if (filterId === 'altitude') {
        return values.map(r => `${r[0] === -Infinity ? '0' : r[0]}~${r[1] === Infinity ? '以上' : r[1]}m`).join('、');
    }
    if (filterId === 'station-code-rule') {
        let rules = [];
        if (values.quick && values.quick.includes('46start')) rules.push('46開頭');
        if (values.quick && values.quick.includes('2nd_2')) rules.push('第2碼為2');
        if (values.custom) {
            values.custom.forEach(c => {
                if (c.type === 'prefix') rules.push(`開頭為${c.value}`);
                if (c.type === 'position') rules.push(`第${c.pos}碼為${c.char}`);
            });
        }
        return rules.join(values.logic === 'and' ? ' 且 ' : ' 或 ');
    }
    return values.map(v => {
        if (filterId === 'city') return rawData.mappings.city[v] || v;
        if (filterId === 'town') return townLabel(v);
        if (filterId === 'station_type') return rawData.mappings.station_type[v] || v;
        if (filterId === 'regional-center') return rawData.mappings.reg[v] || v;
        if (filterId === 'public') {
            const opt = getOptionsByFilterId('public').find(o => String(o.value) === String(v));
            return opt ? opt.text.replace(/🌐|💰| |└/g, '') : v;
        }
        return v;
    }).join('、');
}

function describeFiltersText() {
    const part = (zone) => Object.entries(activeFilters[zone])
        .map(([fid, vals]) => `［${getTitleByFilterId(fid)}：${formatFilterValues(fid, vals)}］`).join(' 且 ');
    const inc = part('include'), exc = part('exclude');
    const out = [];
    out.push(inc ? `包含 ${inc}` : '包含：全部一般測站');
    if (exc) out.push(`排除 ${exc}`);
    if (manualExcludedSids.length > 0) out.push(`手動剔除 ${manualExcludedSids.length} 站`);
    return out.join('；');
}

// --------------------------------------------------------------------------
// 共用：衍生的分類值（分組統計、CSV、健檢共用）
// --------------------------------------------------------------------------
const REGIONAL_CODES = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
function regionalNameOf(s) {
    if (REGIONAL_CODES.includes(Number(s.reg))) return rawData.mappings.reg[s.reg] || String(s.reg);
    return s._my_regional_boss || '（非區域站）';
}
function directRelayOf(s) {
    return (s._upstream_relay_names && s._upstream_relay_names[0]) || '（無，直接傳輸）';
}
const ALT_BINS = [
    { label: '0–500 m', min: -Infinity, max: 500 },
    { label: '500–1000 m', min: 500, max: 1000 },
    { label: '1000–2000 m', min: 1000, max: 2000 },
    { label: '2000–3000 m', min: 2000, max: 3000 },
    { label: '3000 m 以上', min: 3000, max: Infinity }
];
function altBinOf(s) {
    const a = s.alt !== undefined && s.alt !== null && s.alt !== '' ? parseFloat(s.alt) : 0;
    const b = ALT_BINS.find(b => a >= b.min && a < b.max);
    return b ? b.label : ALT_BINS[ALT_BINS.length - 1].label;
}

// ==========================================================================
// 4. 資料更新時間
// ==========================================================================
let dataLastModified = null;   // 由 fetch 回應的 Last-Modified 取得

function showDataUpdated() {
    const el = document.getElementById('data-updated');
    if (!el) return;
    if (dataLastModified) {
        const d = new Date(dataLastModified);
        el.textContent = isNaN(d) ? `資料更新：${dataLastModified}` : `資料更新：${formatDateTime(d)}`;
    } else {
        el.textContent = '資料更新時間：無法取得';
    }
}
function dataUpdatedText() {
    if (!dataLastModified) return '無法取得';
    const d = new Date(dataLastModified);
    return isNaN(d) ? dataLastModified : formatDateTime(d);
}

// ==========================================================================
// 2. 查詢條件存於網址 ＋ 常用查詢
// ==========================================================================
let isRestoringState = false;   // 還原條件期間暫停重算，最後只算一次

function serializeFilters(obj) {
    const out = {};
    Object.entries(obj).forEach(([fid, vals]) => {
        out[fid] = fid === 'altitude'
            ? vals.map(r => [r[0] === -Infinity ? null : r[0], r[1] === Infinity ? null : r[1]])
            : vals;
    });
    return out;
}
function getQueryState() {
    const st = { i: serializeFilters(activeFilters.include), e: serializeFilters(activeFilters.exclude) };
    if (manualExcludedSids.length > 0) st.m = manualExcludedSids.slice();
    return st;
}
function isDefaultState(st) {
    return Object.keys(st.i).length === 0 && !st.m &&
        JSON.stringify(st.e) === JSON.stringify({ status: ['未上架'] });
}
function encodeState(st) {
    const bytes = new TextEncoder().encode(JSON.stringify(st));
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeState(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
}

function syncQueryURL() {
    if (isRestoringState) return;
    try {
        const url = new URL(window.location.href);
        const st = getQueryState();
        if (isDefaultState(st)) url.searchParams.delete('q');
        else url.searchParams.set('q', encodeState(st));
        if (url.href !== window.location.href) history.replaceState(null, '', url.href);
    } catch (e) { /* 舊瀏覽器忽略 */ }
}

// 依狀態重建所有條件卡片與勾選
function applyQueryState(st) {
    isRestoringState = true;
    const missing = [];
    try {
        activeFilters.include = {};
        activeFilters.exclude = {};
        document.querySelectorAll('.active-filter-group').forEach(el => el.remove());
        manualExcludedSids = Array.isArray(st.m) ? st.m.map(String) : [];
        checkedSids.clear();

        [['include', st.i], ['exclude', st.e]].forEach(([zoneType, filters]) => {
            Object.entries(filters || {}).forEach(([fid, vals]) => {
                restoreFilterGroup(zoneType, fid, vals, missing);
            });
        });
    } finally {
        isRestoringState = false;
    }
    calculateStations();
    if (missing.length > 0) showCalToast(`有 ${missing.length} 個條件值在目前資料中找不到，已略過`);
}

function restoreFilterGroup(zoneType, fid, vals, missing) {
    const zone = document.querySelector(`.drop-zone[data-zone="${zoneType}"]`);
    if (!zone || document.getElementById(`${zoneType}-group-${fid}`)) return;
    if (!getTitleByFilterId(fid) || getTitleByFilterId(fid) === fid) { missing.push(fid); return; }
    renderFilterOptions(zone, zoneType, fid);

    if (fid === 'altitude') {
        const ranges = Array.isArray(vals) ? vals : [];
        for (let i = 1; i < ranges.length; i++) addAltitudeRow(zoneType);
        const rows = document.querySelectorAll(`#${zoneType}-altitude-rows .altitude-row`);
        ranges.forEach((r, i) => {
            if (!rows[i]) return;
            rows[i].querySelector('.alt-min').value = (r[0] === null || r[0] === -Infinity) ? '' : r[0];
            rows[i].querySelector('.alt-max').value = (r[1] === null || r[1] === Infinity) ? '' : r[1];
        });
        onAltitudeInputChange(zoneType);
        return;
    }

    if (fid === 'station-code-rule') {
        const group = document.getElementById(`${zoneType}-group-station-code-rule`);
        const logic = group.querySelector('.code-logic-select');
        if (logic && vals.logic) logic.value = vals.logic;
        (vals.quick || []).forEach(q => {
            const cb = group.querySelector(`.quick-rule[value="${CSS.escape(q)}"]`);
            if (cb) cb.checked = true;
        });
        (vals.custom || []).forEach(rule => {
            addStationCodeRuleRow(zoneType);
            const rows = group.querySelectorAll('.code-rule-row');
            const row = rows[rows.length - 1];
            const sel = row.querySelector('.rule-type');
            if (rule.type === 'position') {
                sel.value = 'position';
                toggleRuleInputs(sel, zoneType);
                row.querySelector('.code-pos').value = rule.pos;
                row.querySelector('.code-char').value = rule.char;
            } else {
                row.querySelector('.code-prefix').value = rule.value;
            }
        });
        onCodeRuleInputChange(zoneType);
        return;
    }

    const container = document.getElementById(`${zoneType}-options-${fid}`);
    if (!container) return;
    (Array.isArray(vals) ? vals : []).forEach(v => {
        const cb = container.querySelector(`input[type="checkbox"][value="${CSS.escape(String(v))}"]`);
        if (cb) cb.checked = true; else missing.push(`${fid}:${v}`);
    });
    onCheckboxChange(zoneType, fid);
}

function applyStateFromURL() {
    try {
        const q = new URLSearchParams(window.location.search).get('q');
        if (!q) return false;
        applyQueryState(decodeState(q));
        showCalToast('已套用網址中的查詢條件');
        return true;
    } catch (e) {
        console.warn('網址查詢條件無法解析', e);
        showCalToast('網址中的查詢條件無法解析，已使用預設條件');
        return false;
    }
}

function copyQueryLink() {
    syncQueryURL();
    const href = window.location.href;
    const done = () => showCalToast('已複製查詢連結，貼給同事即可開啟相同條件');
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(href).then(done).catch(() => fallbackCopyText(href, done));
    } else fallbackCopyText(href, done);
}
function fallbackCopyText(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { prompt('請複製以下連結：', text); }
    ta.remove();
}

// --- 常用查詢 ---
// 內建查詢：要新增全單位共用的常用查詢，在這裡加一筆即可（i = 包含池、e = 排除池，值與條件卡片的勾選值相同）
const BUILTIN_PRESETS = [
    { name: '正式上架一般測站（預設）', state: { i: {}, e: { status: ['未上架'] } } },
    { name: '署屬站（正式上架）', state: { i: { unit: ['署屬站'] }, e: { status: ['未上架'] } } },
    { name: '無線電傳輸測站（正式上架）', state: { i: { transport: ['無線電'] }, e: { status: ['未上架'] } } },
    { name: '外單位雨量站（正式上架）', state: { i: { transport: ['外單位雨量資料交換'] }, e: { status: ['未上架'] } } },
    { name: '未上架測站', state: { i: { status: ['未上架'] }, e: {} } }
];
const PRESET_KEY = 'stationCal.presets';
function loadSavedPresets() {
    try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '[]'); } catch (e) { return []; }
}
function saveSavedPresets(list) {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
}

function renderPresetMenu() {
    const menu = document.getElementById('preset-menu');
    if (!menu) return;
    const saved = loadSavedPresets();
    let html = `<div class="preset-section">內建查詢</div>`;
    BUILTIN_PRESETS.forEach((p, i) => {
        html += `<div class="preset-item" data-builtin="${i}"><span>${escHtml(p.name)}</span></div>`;
    });
    html += `<div class="preset-section">我的常用查詢 <small>（存在這台電腦的瀏覽器）</small></div>`;
    if (saved.length === 0) html += `<div class="preset-empty">尚未儲存任何查詢</div>`;
    saved.forEach((p, i) => {
        html += `<div class="preset-item" data-saved="${i}"><span>${escHtml(p.name)}</span><button type="button" class="preset-del" data-del="${i}" title="刪除">✕</button></div>`;
    });
    html += `<div class="preset-save" data-save="1">＋ 將目前條件存為常用查詢…</div>`;
    menu.innerHTML = html;
}

function initPresetsAndShare() {
    const btn = document.getElementById('preset-btn');
    const menu = document.getElementById('preset-menu');
    const shareBtn = document.getElementById('share-query-btn');
    if (shareBtn) shareBtn.addEventListener('click', copyQueryLink);
    if (!btn || !menu) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = menu.style.display === 'block';
        if (!open) renderPresetMenu();
        menu.style.display = open ? 'none' : 'block';
    });
    document.addEventListener('click', (e) => {
        if (!menu.contains(e.target) && e.target !== btn) menu.style.display = 'none';
    });
    menu.addEventListener('click', (e) => {
        e.stopPropagation();   // 選單內容會重新產生，不讓「點外面關閉」誤判
        const del = e.target.closest('[data-del]');
        if (del) {
            const list = loadSavedPresets();
            const i = Number(del.getAttribute('data-del'));
            if (list[i] && confirm(`確定要刪除常用查詢「${list[i].name}」嗎？`)) {
                list.splice(i, 1);
                saveSavedPresets(list);
                renderPresetMenu();
            }
            return;
        }
        if (e.target.closest('[data-save]')) {
            const name = prompt('請輸入這組查詢的名稱：', '');
            if (!name || !name.trim()) return;
            const list = loadSavedPresets();
            list.push({ name: name.trim(), state: getQueryState(), savedAt: new Date().toISOString() });
            if (saveSavedPresets(list)) showCalToast(`已儲存「${name.trim()}」`);
            else showCalToast('這個瀏覽器不允許儲存，請改用「🔗 分享」連結保存');
            renderPresetMenu();
            return;
        }
        const b = e.target.closest('[data-builtin]');
        const s = e.target.closest('[data-saved]');
        let preset = null;
        if (b) preset = BUILTIN_PRESETS[Number(b.getAttribute('data-builtin'))];
        if (s) preset = loadSavedPresets()[Number(s.getAttribute('data-saved'))];
        if (preset) {
            applyQueryState(preset.state);
            menu.style.display = 'none';
            showCalToast(`已套用「${preset.name}」`);
            const mapModal = document.getElementById('map-modal');
            if (mapModal && mapModal.classList.contains('active')) renderMap();
        }
    });
}

// ==========================================================================
// 1. 分組統計
// ==========================================================================
const GROUP_DIMS = [
    { id: 'city', name: '縣市', get: s => [rawData.mappings.city[s.city] || '未知縣市'], order: v => cityOrder(v) },
    { id: 'town', name: '鄉鎮市區', get: s => [townLabel(townPairKey(s.city, s.town))] },
    { id: 'unit', name: '所屬單位', get: s => [s._derivedUnit || '未知'] },
    { id: 'station_type', name: '測站類型', get: s => [rawData.mappings.station_type[s.station_type] || '未知類型'] },
    { id: 'transport', name: '傳輸方式', get: s => [s._derivedTransport || '未分類'] },
    { id: 'regional', name: '區域站歸屬', get: s => [regionalNameOf(s)] },
    { id: 'relay', name: '直屬中繼站', get: s => [directRelayOf(s)] },
    { id: 'weather-freq', name: '氣象資料頻率', get: s => [s._derivedWeatherFreq || '未知'] },
    { id: 'rain-freq', name: '雨量資料頻率', get: s => [s._derivedRainFreq || '未知'] },
    { id: 'vendor', name: '維護廠商', get: s => [s._derivedVendor || '未知'] },
    { id: 'status', name: '上架狀態', get: s => [s._derivedStatus || '未知'] },
    { id: 'altitude', name: '海拔區間', get: s => [altBinOf(s)], order: v => ALT_BINS.findIndex(b => b.label === v) },
    { id: 'public', name: '資料供應管道（可複選）', multi: true, get: s => (s.supply_channels && s.supply_channels.length ? s.supply_channels : ['無對外供應']) }
];
let lastStats = null;

function initStatsModal() {
    const rowSel = document.getElementById('stats-row');
    const colSel = document.getElementById('stats-col');
    if (!rowSel || !colSel) return;
    rowSel.innerHTML = GROUP_DIMS.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
    colSel.innerHTML = `<option value="">（不分欄，只看單一維度）</option>` + GROUP_DIMS.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
    rowSel.value = 'city';
    colSel.value = '';
    rowSel.addEventListener('change', renderStats);
    colSel.addEventListener('change', renderStats);

    const openBtn = document.getElementById('show-stats-btn');
    if (openBtn) openBtn.addEventListener('click', () => { openToolModal('stats-modal'); renderStats(); });
    const exportBtn = document.getElementById('stats-export-btn');
    if (exportBtn) exportBtn.addEventListener('click', exportStatsCSV);
}

function sortKeys(keys, dim, countOf) {
    return keys.sort((a, b) => {
        if (dim.order) {
            const d = dim.order(a) - dim.order(b);
            if (d !== 0) return d;
        } else {
            const d = countOf(b) - countOf(a);
            if (d !== 0) return d;
        }
        return a.localeCompare(b, 'zh-Hant');
    });
}

function computeStats(list, rowDim, colDim) {
    const rowCount = new Map(), colCount = new Map(), cell = new Map();
    list.forEach(s => {
        const rs = [...new Set(rowDim.get(s))];
        const cs = colDim ? [...new Set(colDim.get(s))] : [];
        rs.forEach(r => rowCount.set(r, (rowCount.get(r) || 0) + 1));
        cs.forEach(c => colCount.set(c, (colCount.get(c) || 0) + 1));
        rs.forEach(r => cs.forEach(c => {
            const k = r + '\u0000' + c;
            cell.set(k, (cell.get(k) || 0) + 1);
        }));
    });
    const rows = sortKeys([...rowCount.keys()], rowDim, k => rowCount.get(k));
    const cols = colDim ? sortKeys([...colCount.keys()], colDim, k => colCount.get(k)) : [];
    return { rows, cols, rowCount, colCount, cell, total: list.length };
}

function renderStats() {
    const wrap = document.getElementById('stats-table-wrap');
    const meta = document.getElementById('stats-meta');
    if (!wrap) return;
    const rowDim = GROUP_DIMS.find(d => d.id === document.getElementById('stats-row').value);
    const colId = document.getElementById('stats-col').value;
    const colDim = colId && colId !== rowDim.id ? GROUP_DIMS.find(d => d.id === colId) : null;
    const st = computeStats(currentFilteredList, rowDim, colDim);
    lastStats = { st, rowDim, colDim };

    let note = `目前條件：${describeFiltersText()}　｜　共 ${st.total} 站`;
    if (rowDim.multi || (colDim && colDim.multi)) note += '　｜　⚠️「資料供應管道」可複選，一站可能同時計入多個類別，各類別加總會大於合計';
    meta.textContent = note;

    if (st.total === 0) { wrap.innerHTML = '<p class="stats-empty">目前沒有符合條件的測站</p>'; return; }

    let html = '';
    if (!colDim) {
        const max = Math.max(...st.rows.map(r => st.rowCount.get(r)));
        html += `<table class="stats-table"><thead><tr><th>${escHtml(rowDim.name)}</th><th class="num">站數</th><th class="num">占比</th><th class="bar-col"></th></tr></thead><tbody>`;
        st.rows.forEach(r => {
            const n = st.rowCount.get(r);
            const pct = n / st.total * 100;
            html += `<tr><td>${escHtml(r)}</td><td class="num"><strong>${n}</strong></td><td class="num">${pct.toFixed(1)}%</td>
                     <td class="bar-col"><span class="stat-bar" style="width:${(n / max * 100).toFixed(1)}%"></span></td></tr>`;
        });
        html += `</tbody><tfoot><tr><td>合計（不重複站數）</td><td class="num"><strong>${st.total}</strong></td><td class="num">100%</td><td></td></tr></tfoot></table>`;
    } else {
        let max = 0;
        st.cell.forEach(v => { if (v > max) max = v; });
        html += `<table class="stats-table cross"><thead><tr><th class="corner">${escHtml(rowDim.name)} ＼ ${escHtml(colDim.name)}</th>`;
        st.cols.forEach(c => { html += `<th class="num">${escHtml(c)}</th>`; });
        html += `<th class="num total">合計</th></tr></thead><tbody>`;
        st.rows.forEach(r => {
            html += `<tr><td class="row-head">${escHtml(r)}</td>`;
            st.cols.forEach(c => {
                const v = st.cell.get(r + '\u0000' + c) || 0;
                const shade = v ? (0.08 + 0.32 * v / max).toFixed(3) : 0;
                html += v ? `<td class="num" style="background:rgba(2,132,199,${shade})">${v}</td>` : `<td class="num zero">–</td>`;
            });
            html += `<td class="num total"><strong>${st.rowCount.get(r)}</strong></td></tr>`;
        });
        html += `</tbody><tfoot><tr><td>合計</td>`;
        st.cols.forEach(c => { html += `<td class="num"><strong>${st.colCount.get(c)}</strong></td>`; });
        html += `<td class="num total"><strong>${st.total}</strong></td></tr></tfoot></table>`;
        if (st.cols.length > 15) html = `<p class="stats-hint">欄位類別有 ${st.cols.length} 個，表格可左右捲動；建議把類別較多的維度放在「列」。</p>` + html;
    }
    wrap.innerHTML = html;
}

function exportStatsCSV() {
    if (!lastStats) return;
    const { st, rowDim, colDim } = lastStats;
    const lines = [
        `${csvCell('查詢條件')},${csvCell(describeFiltersText())}`,
        `${csvCell('匯出時間')},${csvCell(formatDateTime(new Date()))}`,
        `${csvCell('資料更新時間')},${csvCell(dataUpdatedText())}`,
        `${csvCell('測站數')},${csvCell(st.total)}`,
        ''
    ];
    if (!colDim) {
        lines.push([rowDim.name, '站數', '占比(%)'].map(csvCell).join(','));
        st.rows.forEach(r => lines.push([r, st.rowCount.get(r), (st.rowCount.get(r) / st.total * 100).toFixed(1)].map(csvCell).join(',')));
        lines.push(['合計', st.total, '100'].map(csvCell).join(','));
    } else {
        lines.push([`${rowDim.name}＼${colDim.name}`, ...st.cols, '合計'].map(csvCell).join(','));
        st.rows.forEach(r => lines.push([r, ...st.cols.map(c => st.cell.get(r + '\u0000' + c) || 0), st.rowCount.get(r)].map(csvCell).join(',')));
        lines.push(['合計', ...st.cols.map(c => st.colCount.get(c)), st.total].map(csvCell).join(','));
    }
    const name = colDim ? `${rowDim.name}x${colDim.name}` : rowDim.name;
    downloadCSV(lines, `分組統計_${name.replace(/[（）()\/\\:*?"<>|]/g, '')}_${new Date().toISOString().slice(0, 10)}.csv`);
}

// ==========================================================================
// 6. 資料健檢
// ==========================================================================
let lastHealth = null;

function runHealthChecks() {
    const M = rawData.mappings;
    const S = stationsArray;
    const sidSet = new Set(S.map(s => s.sid));
    const has = (v) => v !== undefined && v !== null && v !== '';
    const item = (s, detail) => ({ n: s.n, sid: s.sid, cwbid: s.cwbid || '', detail });
    const checks = [];
    const add = (level, title, desc, items) => checks.push({ level, title, desc, items });

    // ---- 錯誤：會讓篩選、地圖或統計出錯 ----
    const hasCoord = s => isFinite(parseFloat(s.lat)) && isFinite(parseFloat(s.lon));
    const inBroad = s => +s.lat >= 3 && +s.lat <= 27 && +s.lon >= 109 && +s.lon <= 123;    // 含東沙、南沙
    const inMain = s => +s.lat >= 21 && +s.lat <= 27 && +s.lon >= 117 && +s.lon <= 123;    // 臺灣本島與澎金馬
    add('error', '座標缺漏或明顯錯誤', 'lat／lon 缺少，或不在合理範圍（北緯 3–27°、東經 109–123°，含東沙、南沙）。這些站無法在分布圖上正確定位。',
        S.filter(s => !hasCoord(s) || !inBroad(s)).map(s => item(s, `lat=${s.lat}, lon=${s.lon}`)));

    add('error', 'repid 指向不存在的測站', '上層中繼站代碼找不到對應測站，「中繼站選擇」篩選與通訊關係會斷掉。',
        S.filter(s => has(s.repid) && !sidSet.has(s.repid)).map(s => item(s, `repid=${s.repid}`)));

    const codeFields = [['city', 'city'], ['town', 'town'], ['main_cat', 'main'], ['sub_cat', 'sub'], ['vendor', 'vendor'], ['reg', 'reg'], ['station_type', 'station_type']];
    const badCodes = [];
    S.forEach(s => {
        codeFields.forEach(([field, map]) => {
            if (has(s[field]) && M[map] && M[map][s[field]] === undefined) badCodes.push(item(s, `${field}=${s[field]} 不在 mappings.${map}`));
        });
    });
    add('error', '代碼不在對照表中', 'city、town、main_cat、sub_cat、vendor、reg、station_type 的代碼在 mappings 中找不到，畫面會顯示「未知」且無法被篩選選到。', badCodes);

    const supplyNames = Object.values(M.data_supply || {});
    const optVals = getOptionsByFilterId('public').map(o => String(o.value));
    const supplyIssues = [];
    optVals.filter(v => !supplyNames.includes(v)).forEach(v => supplyIssues.push({ n: `程式選項「${v}」`, sid: '', cwbid: '', detail: '不在 mappings.data_supply 中，勾選後篩不到任何站' }));
    supplyNames.filter(v => !optVals.includes(v)).forEach(v => supplyIssues.push({ n: `JSON 管道「${v}」`, sid: '', cwbid: '', detail: '程式中沒有對應選項，無法篩選' }));
    add('error', '資料供應選項與 JSON 對照表不一致', '「資料供應狀態」卡片的選項寫死在程式中，需與 mappings.data_supply 的名稱相同。', supplyIssues);

    const regIssues = REGIONAL_CODES.filter(c => !(M.reg && M.reg[c])).map(c => ({ n: `reg 代碼 ${c}`, sid: '', cwbid: '', detail: '程式視為區域中心，但 mappings.reg 中沒有此代碼' }));
    add('error', '區域中心代碼對照', '「區域站歸屬」選項寫死為 reg 8～19，需確認 mappings.reg 仍是 12 個區域中心。', regIssues);

    // ---- 警告：資料不完整，可能造成誤解 ----
    add('warn', '站碼為文字 "nan"', 'cwbid 存成文字 "nan"（多半是轉檔殘留）。網頁已視為沒有站碼，建議在產生 JSON 時改為空值。',
        S.filter(s => s._cwbidWasNan).map(s => item(s, s._derivedStatus)));
    add('warn', '缺少站碼（cwbid）', '站碼規則篩選會改用 sid 判斷。',
        S.filter(s => !s.cwbid && !s._cwbidWasNan).map(s => item(s, s._derivedStatus)));
    const cwCount = {};
    S.forEach(s => { if (s.cwbid) cwCount[s.cwbid] = (cwCount[s.cwbid] || 0) + 1; });
    add('warn', '缺少縣市或鄉鎮', '縣市／鄉鎮篩選選不到這些站。',
        S.filter(s => !has(s.city) || !has(s.town)).map(s => item(s, `city=${s.city ?? ''}, town=${s.town ?? ''}`)));
    add('warn', '傳輸方式為「未分類」', 'sub_cat 不在傳輸方式對照規則中（getTransportType），任何傳輸方式選項都選不到這些站。',
        S.filter(s => s._derivedTransport === '未分類').map(s => item(s, `${s._derivedUnit}（sub_cat=${s.sub_cat}）`)));
    add('warn', '未上架但沒有填寫原因', 'station_publish = 0，但 publish_reason 是空的。',
        S.filter(s => s._derivedStatus === '未上架' && !has(s.publish_reason)).map(s => item(s, '')));
    add('warn', '海拔缺漏或異常', '沒有 alt，或小於 0 m、大於 4000 m。海拔篩選會把缺漏視為 0 m。',
        S.filter(s => !has(s.alt) || !isFinite(parseFloat(s.alt)) || parseFloat(s.alt) < 0 || parseFloat(s.alt) > 4000).map(s => item(s, `alt=${s.alt ?? ''}`)));
    const hubNames = {};
    S.filter(s => s.is_hub === true).forEach(s => { hubNames[s.n] = (hubNames[s.n] || 0) + 1; });
    add('warn', '中繼站同名', '「中繼站選擇」以站名比對，同名中繼站會被視為同一站。',
        S.filter(s => s.is_hub === true && hubNames[s.n] > 1).map(s => item(s, '')));

    // ---- 提示：程式已處理，或屬正常的資料特性 ----
    add('info', '遠洋離島座標', '位於臺灣本島與澎金馬範圍外的測站（如東沙島、南沙島）。座標正確，但分布圖預設視角不含這些站。',
        S.filter(s => hasCoord(s) && inBroad(s) && !inMain(s)).map(s => item(s, `lat=${s.lat}, lon=${s.lon}`)));
    add('info', '站碼重複', '同一個 cwbid 出現在多個測站。目前多為同一地點的署屬有人站與區域中心共用站碼，屬正常；若出現其他組合請確認。',
        S.filter(s => s.cwbid && cwCount[s.cwbid] > 1)
            .sort((a, b) => String(a.cwbid).localeCompare(String(b.cwbid)))
            .map(s => item(s, `cwbid ${s.cwbid} 共 ${cwCount[s.cwbid]} 站`)));
    const townCities = {};
    S.forEach(s => {
        if (!has(s.town)) return;
        (townCities[s.town] = townCities[s.town] || new Set()).add(M.city[s.city] || s.city);
    });
    add('info', '同名鄉鎮共用代碼', 'mappings.town 依名稱編號，不同縣市的同名區共用代碼。網頁已改用「縣市＋鄉鎮」組合處理，不影響篩選。',
        Object.entries(townCities).filter(([, c]) => c.size > 1).map(([t, c]) => ({ n: M.town[t] || t, sid: '', cwbid: '', detail: `town=${t}：${[...c].join('、')}` })));
    add('info', '維護廠商為「未知」', 'vendor 為空或不在對照表，「維護廠商」選項不會列出「未知」。',
        S.filter(s => s._derivedVendor === '未知').map(s => item(s, `vendor=${s.vendor ?? ''}`)));

    return checks;
}

const LEVEL_META = {
    error: { icon: '⛔', label: '錯誤', cls: 'lv-error' },
    warn: { icon: '⚠️', label: '警告', cls: 'lv-warn' },
    info: { icon: 'ℹ️', label: '提示', cls: 'lv-info' },
    pass: { icon: '✅', label: '通過', cls: 'lv-pass' }
};

function renderHealth() {
    const body = document.getElementById('health-body');
    if (!body || !rawData) return;
    const checks = runHealthChecks();
    lastHealth = checks;
    const cnt = { error: 0, warn: 0, info: 0, pass: 0 };
    checks.forEach(c => { if (c.items.length === 0) cnt.pass++; else cnt[c.level]++; });

    let html = `<div class="health-summary">
        <span class="hs lv-error">⛔ 錯誤 <b>${cnt.error}</b> 項</span>
        <span class="hs lv-warn">⚠️ 警告 <b>${cnt.warn}</b> 項</span>
        <span class="hs lv-info">ℹ️ 提示 <b>${cnt.info}</b> 項</span>
        <span class="hs lv-pass">✅ 通過 <b>${cnt.pass}</b> 項</span>
        <span class="hs-meta">共檢查 ${stationsArray.length} 站｜${escHtml(dataUpdatedText() === '無法取得' ? '' : '資料更新 ' + dataUpdatedText())}</span>
    </div>`;
    const order = { error: 0, warn: 1, info: 2 };
    const sorted = checks.slice().sort((a, b) => ((a.items.length === 0) - (b.items.length === 0)) || order[a.level] - order[b.level]);
    sorted.forEach(c => {
        const lv = c.items.length === 0 ? LEVEL_META.pass : LEVEL_META[c.level];
        html += `<details class="health-item"><summary><span class="lv-badge ${lv.cls}">${lv.icon} ${lv.label}</span>
                 <span class="hi-title">${escHtml(c.title)}</span><span class="hi-count">${c.items.length ? c.items.length + ' 筆' : ''}</span></summary>
                 <div class="hi-body"><p>${escHtml(c.desc)}</p>`;
        if (c.items.length) {
            const shown = c.items.slice(0, 300);
            html += `<table class="stats-table"><thead><tr><th>站名／項目</th><th>sid</th><th>cwbid</th><th>說明</th></tr></thead><tbody>`;
            shown.forEach(it => { html += `<tr><td>${escHtml(it.n)}</td><td>${escHtml(it.sid)}</td><td>${escHtml(it.cwbid)}</td><td>${escHtml(it.detail)}</td></tr>`; });
            html += `</tbody></table>`;
            if (c.items.length > shown.length) html += `<p class="stats-hint">僅顯示前 ${shown.length} 筆，完整清單請按「匯出問題清單」。</p>`;
        }
        html += `</div></details>`;
    });
    body.innerHTML = html;
}

function exportHealthCSV() {
    if (!lastHealth) return;
    const lines = [
        `${csvCell('資料健檢')},${csvCell(formatDateTime(new Date()))}`,
        `${csvCell('資料更新時間')},${csvCell(dataUpdatedText())}`,
        '',
        ['等級', '檢查項目', '站名／項目', 'sid', 'cwbid', '說明'].map(csvCell).join(',')
    ];
    lastHealth.forEach(c => c.items.forEach(it => {
        lines.push([LEVEL_META[c.level].label, c.title, it.n, it.sid, it.cwbid, it.detail].map(csvCell).join(','));
    }));
    downloadCSV(lines, `資料健檢_${new Date().toISOString().slice(0, 10)}.csv`);
}

function initHealthModal() {
    const btn = document.getElementById('health-btn');
    if (btn) btn.addEventListener('click', () => { openToolModal('health-modal'); renderHealth(); });
    const exp = document.getElementById('health-export-btn');
    if (exp) exp.addEventListener('click', exportHealthCSV);
}

// --- 工具視窗共用：關閉按鈕與點背景關閉 ---
function initToolModals() {
    document.querySelectorAll('[data-close-modal]').forEach(b => {
        b.addEventListener('click', () => closeToolModal(b.getAttribute('data-close-modal')));
    });
    ['stats-modal', 'health-modal'].forEach(id => {
        const m = document.getElementById(id);
        if (m) m.addEventListener('click', (e) => { if (e.target === m) closeToolModal(id); });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') ['stats-modal', 'health-modal'].forEach(closeToolModal);
    });
}
