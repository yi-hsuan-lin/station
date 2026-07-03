// ==========================================================================
// 1. 全局變數與資料庫初始化
// ==========================================================================
let rawData = null;           /* 儲存原始 JSON 完整資料 */
let stationsArray = [];       /* 儲存前處理過、貼好標籤的完整測站陣列 */
let currentFilteredList = []; /* 儲存目前被篩選出來的測站陣列，供 CSV 匯出使用 */

// 地圖專用全域變數
let taiwanGeoData = null;     /* 儲存台灣縣市邊界資料 */
let mapInstance = null;       /* Leaflet 地圖實體 */
let markersLayer = null;      /* 測站標記圖層 */

// 追蹤目前被拖曳的卡片 ID
let draggedFilterId = null;

// 儲存目前在過濾池中被選取的條件
const activeFilters = {
    include: {},
    exclude: {}
};

// 網頁載入時立刻讀取 JSON 資料
document.addEventListener("DOMContentLoaded", () => {
    fetch('taiwan.json')
        .then(response => response.json())
        .then(data => { taiwanGeoData = data; })
        .catch(err => console.error("台灣地圖載入失敗:", err));

    fetch('stationData.json')
        .then(response => response.json())
        .then(data => {
            rawData = data;
            initStationData();   
            initDragAndDrop();  
            initDefaultFilters(); 
            calculateStations(); 
        })
        .catch(err => console.error("JSON 資料載入失敗:", err));

    const exportBtn = document.getElementById('export-csv-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', exportToCSV);
    }

    // ==========================================================================
    // 🚀 ✨ 終極黃金修正：地圖圖片下載邏輯（地毯式全圖層 2D 降維轉換，解決錯位切圖）
    // ==========================================================================
    const downloadMapBtn = document.getElementById('download-map-btn');
    if (downloadMapBtn) {
        downloadMapBtn.addEventListener('click', () => {
            const mapContainer = document.getElementById('map-container');
            if (!mapContainer) return;

            // 1. 隱藏左上角的 Leaflet [+ -] 縮放按鈕，讓截圖更乾淨
            const zoomControl = mapContainer.querySelector('.leaflet-control-zoom');
            if (zoomControl) zoomControl.style.display = 'none';

            // 2. 🎯 核心除錯大腦：地毯式掃描地圖內部「所有」子元件，強制將 3D 位移扁平化為 2D
            const modifiedElements = [];
            
            mapContainer.querySelectorAll('*').forEach(el => {
                // A. 處理 Leaflet 最常用的 inline style "translate3d"
                const inlineTransform = el.style.transform;
                if (inlineTransform && inlineTransform.includes('translate3d')) {
                    modifiedElements.push({ el: el, oldTransform: inlineTransform });
                    // 強制將 translate3d(Xpx, Ypx, 0px) 替換為 html2canvas 看得懂的 translate(Xpx, Ypx)
                    el.style.transform = inlineTransform.replace('translate3d', 'translate');
                } 
                // B. 處理部分高階底圖計算出來的 "matrix3d"
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

            // 3. 呼叫 html2canvas 開始拍照（回歸原生精準裁剪）
            html2canvas(mapContainer, {
                useCORS: true,         
                backgroundColor: '#ffffff',
                logging: false
            }).then(canvas => {
                // 4. 🎯 拍照完畢，光速还原所有地圖元件的原生 3D 樣式與縮放按鈕，防網頁破圖
                if (zoomControl) zoomControl.style.display = '';
                modifiedElements.forEach(item => {
                    item.el.style.transform = item.oldTransform;
                });

                // 5. 觸發下載
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

    // 地圖彈出視窗顯示/關閉控制
    const mapBtn = document.getElementById('show-map-btn');
    const closeMapBtn = document.getElementById('close-map-btn');
    const mapModal = document.getElementById('map-modal');
    const modalContent = document.querySelector('.modal-content');

    if (mapBtn && closeMapBtn && mapModal && modalContent) {
        mapBtn.addEventListener('click', () => {
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

    // 初始化拉伸大腦
    initMainPanelResizer(); 
    initSubPanelResizer();  
    initModalResizer();     
});

// ==========================================================================
// 🛠️ 控制「過濾池」與「結果區」中間交界處的拉伸功能
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
        station._derivedUnit = getDerivedUnitString(station);
        station._derivedVendor = getDerivedVendorString(station);
        station._derivedTransport = getTransportType(station.sub_cat);
        station._derivedWeatherFreq = getWeatherFreq(station.sub_cat);
        station._derivedRainFreq = getRainFreq(station.sub_cat);
        station._derivedPublic = [1, 2, 4, 5, 7].includes(station.main_cat) ? "有對外提供" : "沒有對外提供";

        const cwbidClean = (station.cwbid || "").trim();
        station._derivedStatus = (cwbidClean === "" || cwbidClean.toLowerCase() === "nan") ? "未上架" : "正式上架站";
    });
}

function getDerivedUnitString(station) {
    if (station.main_cat !== 7) return rawData.mappings.main[station.main_cat] || "其他";
    const subName = rawData.mappings.sub[station.sub_cat] || "外單位雨量站";
    if (station.sub_cat === 11) {
        if (station.vendor === 5) return "北市府大地工程處";
        if (station.vendor === 6) return "北市府水利工程處";
        return "北市府(其他)";
    }
    return subName;
}

function getDerivedVendorString(station) {
    if (station.vendor !== 7) return rawData.mappings.vendor[station.vendor] || "未指定";
    if (station.reg === 23) return "十河分署-翡翠水庫";
    if (station.reg === 24) return "十河分署-石門水庫";
    if (station.reg === 25) return "十河分署-第10河川局";
    return "十河分署";
}

// ==========================================================================
// 3. 拖曳介面與常規函數
// ==========================================================================
function getTransportType(sub) {
    if (sub === 8) return "無線電";
    if ([3, 5, 6, 9].includes(sub)) return "4G";
    if ([1, 2].includes(sub)) return "實體網路";
    if ([10, 11, 12, 13, 14, 15].includes(sub)) return "外單位雨量資料交換";
    return "未分類";
}
// 修正 2026 年氣象觀測頻率標準業務判斷邏輯
function getWeatherFreq(sub) {
    if ([10, 11, 12, 13, 14, 15].includes(sub)) return "不接受篩選(純雨量站)";
    return sub === 8 ? "10分鐘" : "1分鐘";
}
// 修正 2026 年雨量傳輸頻率標準業務判斷邏輯
function getRainFreq(sub) {
    return [10, 11, 12, 13, 14, 15].includes(sub) ? "10分鐘" : "1分鐘";
}

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
                if (document.getElementById(`${zoneType}-group-${draggedFilterId}`)) return;
                renderFilterOptions(zone, zoneType, draggedFilterId);
                draggedFilterId = null;
            }
        });
    });
}

function initDefaultFilters() {
    const excludeZone = document.querySelector('.drop-zone[data-zone="exclude"]');
    if (!excludeZone) return;

    renderFilterOptions(excludeZone, 'exclude', 'public');
    const publicContainer = document.getElementById('exclude-options-public');
    if (publicContainer) {
        const checkboxPublic = publicContainer.querySelector('input[value="沒有對外提供"]');
        if (checkboxPublic) {
            checkboxPublic.checked = true;
            activeFilters.exclude['public'] = ['沒有對外提供'];
        }
    }

    renderFilterOptions(excludeZone, 'exclude', 'status');
    const statusContainer = document.getElementById('exclude-options-status');
    if (statusContainer) {
        const checkboxStatus = statusContainer.querySelector('input[value="未上架"]');
        if (checkboxStatus) {
            checkboxStatus.checked = true;
            activeFilters.exclude['status'] = ['未上架'];
        }
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
            <div style="display:flex; align-items:center; gap:8px; padding:10px 0;" id="${zoneType}-options-${filterId}">
                <input type="number" class="alt-min" placeholder="最低(m)" min="0" max="4000" 
                       style="width: 85px; padding: 6px; background:#1e293b; border: 1px solid #475569; border-radius: 6px; color:white; font-size:0.85rem;"
                       oninput="onAltitudeInputChange('${zoneType}')">
                <span style="color:#94a3b8;">~</span>
                <input type="number" class="alt-max" placeholder="最高(m)" min="0" max="4000" 
                       style="width: 85px; padding: 6px; background:#1e293b; border: 1px solid #475569; border-radius: 6px; color:white; font-size:0.85rem;"
                       oninput="onAltitudeInputChange('${zoneType}')">
                <span style="font-size: 0.85rem; color: #94a3b8;">公尺</span>
            </div>
        `;
    } else {
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
    zone.appendChild(groupDiv);

    if (filterId === 'town') handleTownSelect連動(zoneType);
}

function getOptionsByFilterId(id) {
    if (id === 'city') {
        const northToSouthCities = ["基隆市", "臺北市", "新北市", "桃園市", "新竹市", "新竹縣", "苗栗縣", "臺中市", "彰化縣", "南投縣", "雲林縣", "嘉義市", "嘉義縣", "臺南市", "高雄市", "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣", "澎湖縣", "金門縣", "連江縣"];
        const cityEntries = Object.entries(rawData.mappings.city);
        cityEntries.sort((a, b) => {
            let idxA = northToSouthCities.indexOf(a[1]);
            let idxB = northToSouthCities.indexOf(b[1]);
            if (idxA === -1) idxA = 999;
            if (idxB === -1) idxB = 999;
            return idxA - idxB;
        });
        return cityEntries.map(([k,v]) => ({value: k, text: v}));
    }
    if (id === 'town') {
        const northToSouthCities = ["基隆市", "臺北市", "新北市", "桃園市", "新竹市", "新竹縣", "苗栗縣", "臺中市", "彰化縣", "南投縣", "雲林縣", "嘉義市", "嘉義縣", "臺南市", "高雄市", "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣", "澎湖縣", "金門縣", "連江縣"];
        const townToCityMap = {};
        stationsArray.forEach(s => { if (s.town && s.city) townToCityMap[s.town] = s.city; });
        const townEntries = Object.entries(rawData.mappings.town);
        
        townEntries.sort((a, b) => {
            const cityNameA = rawData.mappings.city[townToCityMap[a[0]]] || "";
            const cityNameB = rawData.mappings.city[townToCityMap[b[0]]] || "";
            let idxA = northToSouthCities.indexOf(cityNameA);
            let idxB = northToSouthCities.indexOf(cityNameB);
            if (idxA === -1) idxA = 999;
            if (idxB === -1) idxB = 999;
            if (idxA !== idxB) return idxA - idxB;
            return a[1].localeCompare(b[1], 'zh-Hant');
        });
        return townEntries.map(([k,v]) => ({value: k, text: v}));
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
    if (id === 'unit') return [...new Set(stationsArray.map(s => s._derivedUnit))].map(v => ({value: v, text: v}));
    if (id === 'transport') return ['無線電', '4G', '實體網路', '外單位雨量資料交換'].map(v => ({value: v, text: v}));
    if (id === 'weather-freq') return ['1分鐘', '10分鐘'].map(v => ({value: v, text: v}));
    if (id === 'rain-freq') return ['1分鐘', '10分鐘'].map(v => ({value: v, text: v}));
    if (id === 'vendor') return [...new Set(stationsArray.map(s => s._derivedVendor))].map(v => ({value: v, text: v}));
    if (id === 'public') {
        return [{value: '有對外提供', text: '有對外提供'}, {value: '沒有對外提供', text: '沒有對外提供', hint: '(空品、機場站)'}];
    }
    if (id === 'status') {
        return [{value: '正式上架站', text: '正式上架站'}, {value: '未上架', text: '未上架', hint: '(教學、備援站)'}];
    }
    return [];
}

function getTitleByFilterId(id) {
    const titles = { unit: '所屬單位', transport: '傳輸方式', city: '縣市', town: '鄉鎮市區', 'weather-freq': '氣象頻率', 'rain-freq': '雨量頻率', vendor: '維護廠商', public: '對外提供', station_type: '測站類型', 'regional-center': '區域站歸屬', status: '上架狀態', altitude: '海拔高度' };
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
    calculateStations();
}

function onAltitudeInputChange(zoneType) {
    const container = document.getElementById(`${zoneType}-options-altitude`);
    if (!container) return;

    const minVal = container.querySelector('.alt-min').value;
    const maxVal = container.querySelector('.alt-max').value;

    const min = minVal !== "" ? parseFloat(minVal) : -Infinity;
    const max = maxVal !== "" ? parseFloat(maxVal) : Infinity;

    activeFilters[zoneType]['altitude'] = [min, max];
    calculateStations();
}

function removeFilterGroup(zoneType, filterId) {
    const el = document.getElementById(`${zoneType}-group-${filterId}`);
    if (el) el.remove();
    delete activeFilters[zoneType][filterId];
    if (filterId === 'city') handleTownSelect連動(zoneType);
    calculateStations();
}

function handleTownSelect連動(zoneType) {
    const townContainer = document.getElementById(`${zoneType}-options-town`);
    if (!townContainer) return;

    const selectedCities = activeFilters[zoneType]['city'] || [];
    const labels = townContainer.querySelectorAll('label');

    labels.forEach(label => {
        const checkbox = label.querySelector('input');
        const townValue = parseInt(checkbox.value);
        const targetStations = stationsArray.filter(s => s.town === townValue);
        
        if (selectedCities.length === 0) {
            label.style.display = 'flex';
        } else {
            const isMatch = targetStations.some(s => selectedCities.includes(s.city.toString()));
            if (isMatch) {
                label.style.display = 'flex';
            } else {
                label.style.display = 'none';
                checkbox.checked = false;
            }
        }
    });
}

function calculateStations() {
    if (!stationsArray.length) return;

    const hasTypeInInclude = activeFilters.include['station_type'] !== undefined;
    const hasTypeInExclude = activeFilters.exclude['station_type'] !== undefined;

    let filteredResults = stationsArray.filter(station => {
        if (hasTypeInInclude || hasTypeInExclude) return true; 
        return station.is_hub !== true && station.is_reg_center !== true;
    });

    Object.entries(activeFilters.include).forEach(([filterId, values]) => {
        filteredResults = filteredResults.filter(station => {
            if (filterId === 'altitude') {
                const stationAlt = station.alt !== undefined && station.alt !== null ? parseFloat(station.alt) : 0;
                return stationAlt >= values[0] && stationAlt <= values[1];
            }
            if (filterId === 'city') return values.includes(station.city.toString());
            if (filterId === 'town') return values.includes(station.town.toString());
            if (filterId === 'station_type') return station.station_type !== undefined && values.includes(station.station_type.toString());
            if (filterId === 'regional-center') return values.includes(station.reg.toString());
            if (filterId === 'unit') return values.includes(station._derivedUnit);
            if (filterId === 'transport') return values.includes(station._derivedTransport);
            if (filterId === 'weather-freq') return values.includes(station._derivedWeatherFreq);
            if (filterId === 'rain-freq') return values.includes(station._derivedRainFreq);
            if (filterId === 'vendor') return values.includes(station._derivedVendor);
            if (filterId === 'public') return values.includes(station._derivedPublic);
            if (filterId === 'status') return values.includes(station._derivedStatus);
            return true;
        });
    });

    Object.entries(activeFilters.exclude).forEach(([filterId, values]) => {
        filteredResults = filteredResults.filter(station => {
            let matchExclude = false;
            if (filterId === 'altitude') {
                const stationAlt = station.alt !== undefined && station.alt !== null ? parseFloat(station.alt) : 0;
                matchExclude = (stationAlt >= values[0] && stationAlt <= values[1]);
            }
            else if (filterId === 'city') matchExclude = values.includes(station.city.toString());
            else if (filterId === 'town') matchExclude = values.includes(station.town.toString());
            else if (filterId === 'station_type') matchExclude = station.station_type !== undefined && values.includes(station.station_type.toString());
            else if (filterId === 'regional-center') matchExclude = values.includes(station.reg.toString());
            else if (filterId === 'unit') matchExclude = values.includes(station._derivedUnit);
            else if (filterId === 'transport') matchExclude = values.includes(station._derivedTransport);
            else if (filterId === 'weather-freq') matchExclude = values.includes(station._derivedWeatherFreq);
            else if (filterId === 'rain-freq') matchExclude = values.includes(station._derivedRainFreq);
            else if (filterId === 'vendor') matchExclude = values.includes(station._derivedVendor);
            else if (filterId === 'public') matchExclude = values.includes(station._derivedPublic);
            else if (filterId === 'status') matchExclude = values.includes(station._derivedStatus);
            
            return !matchExclude; 
        });
    });

    currentFilteredList = filteredResults;

    const totalElement = document.getElementById('total-stations');
    if (totalElement) totalElement.innerText = filteredResults.length;

    renderTable(filteredResults);
}

function renderTable(list) {
    const tbody = document.getElementById('station-table-body');
    if (!tbody) return;

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #ef4444;">無符合目前組合條件的測站</td></tr>`;
        return;
    }

    let html = "";
    list.forEach(s => {
        const cityName = rawData.mappings.city[s.city] || "未知";
        const townName = rawData.mappings.town[s.town] || s.town || "無";
        const cwbidClean = (s.cwbid || "").trim();
        const displayCwbid = (cwbidClean === "" || cwbidClean.toLowerCase() === "nan") 
            ? `<span style="color:#94a3b8; font-style:italic;">未上架(${s.sid})</span>` 
            : `<strong>${s.cwbid}</strong>`;

        const displayAlt = (s.alt !== undefined && s.alt !== null) ? `${s.alt} 公尺` : "-";

        html += `<tr><td>${displayCwbid}</td><td>${s.n}</td><td>${cityName}</td><td>${townName}</td><td><span style="font-size:0.8rem; background:#334155; padding:2px 6px; border-radius:4px; color:#38bdf8;">${displayAlt}</span></td></tr>`;
    });
    tbody.innerHTML = html;
}

function exportToCSV() {
    if (currentFilteredList.length === 0) {
        alert("目前沒有符合條件的測站資料可以匯出！");
        return;
    }
    const headers = ["原始站碼(sid)", "正式代碼(cwbid)", "站名", "縣市", "鄉鎮市區", "高度(alt)", "傳輸方式", "所屬單位", "維護廠商"];
    const rows = currentFilteredList.map(s => {
        const cityName = rawData.mappings.city[s.city] || "未知";
        const townName = rawData.mappings.town[s.town] || s.town || "無";
        return [s.sid, s.cwbid || "", s.n, cityName, townName, s.alt !== undefined ? s.alt : "", s._derivedTransport, s._derivedUnit, s._derivedVendor].map(val => `"${String(val).replace(/"/g, '""')}"`).join(","); 
    });
    const csvContent = [headers.join(","), ...rows].join("\r\n");
    const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `測站篩選結果匯出_${new Date().toISOString().slice(0,10)}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
            if (newHeight >= 100 && newHeight <= 300) {
                counterCard.style.height = `${newHeight}px`;
                counterCard.style.padding = newHeight < 130 ? '10px 24px' : '20px 24px';
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

            if (newWidth >= 450 && newWidth <= window.innerWidth * 0.95) {
                modalContent.style.width = `${newWidth}px`;
            }
            if (newHeight >= 400 && newHeight <= window.innerHeight * 0.95) {
                modalContent.style.height = `${newHeight}px`;
            }

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
            if (mapInstance) {
                mapInstance.invalidateSize();
            }
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

// ==========================================================================
// 🗺️ 渲染測站分布地圖 (已升級 preferCanvas 效能引擎，支援高解析無痛截圖)
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
        { stroke: "#ea580c", fill: "#ffedd5" }  
    ];

    const activeIncludeKeys = Object.keys(activeFilters.include).filter(k => k !== 'altitude');
    let colorKey = null;
    let valueColorMap = {};
    let legendItems = []; 

    if (activeIncludeKeys.length > 0) {
        colorKey = activeIncludeKeys[0]; 
        const chosenValues = activeFilters.include[colorKey];
        const labelTitle = getTitleByFilterId(colorKey);
        
        chosenValues.forEach((val, index) => {
            const colorObj = colorPalette[index % colorPalette.length];
            valueColorMap[val] = colorObj;
            
            let displayTxt = val;
            if (colorKey === 'city') displayTxt = rawData.mappings.city[val] || val;
            else if (colorKey === 'town') displayTxt = rawData.mappings.town[val] || val;
            else if (colorKey === 'station_type') displayTxt = rawData.mappings.station_type[val] || val;
            else if (colorKey === 'regional-center') displayTxt = rawData.mappings.reg[val] || val;
            
            legendItems.push({
                color: colorObj.stroke,
                label: `${labelTitle}：${displayTxt}`
            });
        });
    } else {
        legendItems.push({ color: "#0284c7", label: "觀測站點" });
    }

    if (!mapInstance) {
        mapContainer.innerHTML = '';
        // 🚀 關鍵升級：preferCanvas: true 讓向量測站全部改在畫布渲染，大幅提高 html2canvas 相容度
        mapInstance = L.map('map-container', {
            zoomControl: true,
            attributionControl: false,
            preferCanvas: true 
        }).setView([23.7, 120.9], 7);

        if (taiwanGeoData) {
            L.geoJSON(taiwanGeoData, {
                style: { color: "#cbd5e1", weight: 1.5, fillColor: "#f8fafc", fillOpacity: 1 }
            }).addTo(mapInstance);
        }

        mapInstance.on('zoomend', () => {
            if (!markersLayer) return;
            const currentZoom = mapInstance.getZoom();
            const newRadius = getRadiusByZoom(currentZoom);
            markersLayer.eachLayer(marker => {
                if (typeof marker.setRadius === 'function') marker.setRadius(newRadius);
            });
        });
    }

    if (mapInstance.legendControl) {
        mapInstance.removeControl(mapInstance.legendControl);
    }

    mapInstance.legendControl = L.control({ position: 'bottomright' }); 
    mapInstance.legendControl.onAdd = function () {
        const div = L.DomUtil.create('div', 'map-legend');
        div.style.background = '#ffffff'; div.style.padding = '12px 16px'; div.style.borderRadius = '8px';
        div.style.boxShadow = '0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)';
        div.style.border = '1px solid #e2e8f0'; div.style.color = '#0f172a';
        div.style.fontSize = '0.75rem'; div.style.fontFamily = 'inherit';
        div.style.lineHeight = '1.5'; div.style.maxWidth = '420px';

        let html = `<h4 style="margin: 0 0 8px 0; font-size: 0.8rem; border-bottom: 2px solid #cbd5e1; padding-bottom: 4px; color: #1e293b; font-weight:bold;">🗺️ 目前地圖圖例</h4>`;
        
        const useGrid = legendItems.length > 5;
        if (useGrid) {
            html += `<div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 16px;">`;
        } else {
            html += `<div style="display: flex; flex-direction: column; gap: 4px;">`;
        }

        legendItems.forEach(item => {
            html += `<div style="display: flex; align-items: center; gap: 6px; white-space: nowrap;"><span style="flex-shrink:0; display: inline-block; width: 8px; height: 8px; background-color: ${item.color}; border-radius: 50%; border: 1px solid rgba(0,0,0,0.15);"></span><span style="font-weight: 500; color: #334155;">${item.label}</span></div>`;
        });
        
        html += `</div>`; div.innerHTML = html; return div;
    };
    mapInstance.legendControl.addTo(mapInstance);

    if (markersLayer) {
        mapInstance.removeLayer(markersLayer);
    }
    markersLayer = L.featureGroup().addTo(mapInstance);

    const initZoom = mapInstance.getZoom();
    const initRadius = getRadiusByZoom(initZoom);

    currentFilteredList.forEach(s => {
        if (s.lat && s.lon) {
            let dotColor = "#0284c7"; let fillColor = "#38bdf8"; let matchValueName = "";

            if (colorKey) {
                let stationValue = "";
                if (colorKey === 'unit') stationValue = s._derivedUnit;
                else if (colorKey === 'transport') stationValue = s._derivedTransport;
                else if (colorKey === 'city') stationValue = s.city.toString();
                else if (colorKey === 'town') stationValue = s.town.toString();
                else if (colorKey === 'weather-freq') stationValue = s._derivedWeatherFreq;
                else if (colorKey === 'rain-freq') stationValue = s._derivedRainFreq;
                else if (colorKey === 'vendor') stationValue = s._derivedVendor;
                else if (colorKey === 'public') stationValue = s._derivedPublic;
                else if (colorKey === 'status') stationValue = s._derivedStatus;
                else if (colorKey === 'station_type') stationValue = s.station_type?.toString();
                else if (colorKey === 'regional-center') stationValue = s.reg?.toString();

                if (colorKey === 'city') matchValueName = rawData.mappings.city[s.city] || s.city;
                else if (colorKey === 'town') matchValueName = rawData.mappings.town[s.town] || s.town;
                else if (colorKey === 'station_type') matchValueName = rawData.mappings.station_type[s.station_type] || s.station_type;
                else if (colorKey === 'regional-center') matchValueName = rawData.mappings.reg[s.reg] || s.reg;
                else matchValueName = stationValue;

                if (valueColorMap[stationValue]) {
                    dotColor = valueColorMap[stationValue].stroke;
                    fillColor = valueColorMap[stationValue].fill;
                } else {
                    dotColor = "#64748b"; fillColor = "#cbd5e1";
                }
            }

            const marker = L.circleMarker([s.lat, s.lon], {
                radius: initRadius, color: dotColor, weight: 1.5, fillColor: fillColor, fillOpacity: 0.85        
            });

            let badgeHtml = "";
            if (colorKey && matchValueName) {
                const labelTitle = getTitleByFilterId(colorKey);
                badgeHtml = `<div style="margin-top: 4px; font-size: 0.75rem; background: ${dotColor}1a; color: ${dotColor}; border: 1px solid ${dotColor}40; padding: 1px 6px; border-radius: 4px; display: inline-block;">${labelTitle}：${matchValueName}</div>`;
            }

            marker.bindTooltip(`<div style="text-align:center;"><span style="color:#64748b; font-size:0.75rem;">${s.cwbid || s.sid}</span><br><strong style="font-size:1rem; color:#0f172a;">${s.n}</strong><br>${badgeHtml}</div>`, {
                direction: 'top', className: 'map-tooltip', offset: [0, -5]
            });

            markersLayer.addLayer(marker);
        }
    });

    setTimeout(() => {
        mapInstance.invalidateSize(); 
        if (currentFilteredList.length > 0) {
            const boundsPoints = [];
            currentFilteredList.forEach(s => {
                if (s.lat && s.lon && parseFloat(s.lat) > 21.5) boundsPoints.push([s.lat, s.lon]);
            });

            if (boundsPoints.length > 0) {
                mapInstance.fitBounds(L.latLngBounds(boundsPoints), { padding: [45, 45] });
            } else {
                mapInstance.setView([currentFilteredList[0].lat, currentFilteredList[0].lon], 9);
            }
        } else {
            mapInstance.setView([23.7, 120.9], 7);
        }
    }, 360); 
}