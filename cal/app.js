// ==========================================================================
// 1. 全局變數與資料庫初始化
// ==========================================================================
let rawData = null;       /* 儲存原始 JSON 完整資料 */
let stationsArray = [];   /* 儲存前處理過、貼好標籤的完整測站陣列 */
let currentFilteredList = []; /* 儲存目前被篩選出來的測站陣列，供 CSV 匯出使用 */

// 追蹤目前被拖曳的卡片 ID
let draggedFilterId = null;

// 儲存目前在過濾池中被選取的條件
const activeFilters = {
    include: {},
    exclude: {}
};

// 網頁載入時立刻讀取 JSON 資料
document.addEventListener("DOMContentLoaded", () => {
    fetch('stationData.json')
        .then(response => response.json())
        .then(data => {
            rawData = data;
            initStationData();   
            initDragAndDrop();  
            calculateStations(); 
            initMainPanelResizer(); // ✨ 改為初始化：大板塊中線拉伸功能
        })
        .catch(err => console.error("JSON 資料載入失敗:", err));

    const exportBtn = document.getElementById('export-csv-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', exportToCSV);
    }
});

// ==========================================================================
// 🛠️ 大功臣：控制「過濾池」與「結果區」中間交界處的拉伸大腦
// ==========================================================================
function initMainPanelResizer() {
    const resizer = document.getElementById('main-panel-resizer');
    const container = document.querySelector('.app-container');
    if (!resizer || !container) return;

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        resizer.classList.add('resizing');

        const onMouseMove = (moveEvent) => {
            // 計算滑鼠當前位置距離視窗右側的距離 (就是右側戰情結果區的新寬度)
            const newRightWidth = window.innerWidth - moveEvent.clientX;

            // 限制：右側區塊最少 300px，最多不超過視窗的一半，避免把過濾池擠到不見
            if (newRightWidth > 300 && newRightWidth < window.innerWidth * 0.6) {
                // 動態修改網頁最外層 Grid 的三欄 + 一條線的寬度
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

function getTransportType(sub) {
    if (sub === 8) return "無線電";
    if ([3, 5, 6, 9].includes(sub)) return "4G";
    if ([1, 2].includes(sub)) return "實體網路";
    if ([10, 11, 12, 13, 14, 15].includes(sub)) return "外單位雨量資料交換";
    return "未分類";
}
function getWeatherFreq(sub) {
    if ([10, 11, 12, 13, 14, 15].includes(sub)) return "不接受篩選(純雨量站)";
    return sub === 8 ? "10分鐘" : "1分鐘";
}
function getRainFreq(sub) {
    return [10, 11, 12, 13, 14, 15].includes(sub) ? "10分鐘" : "1分鐘";
}

// ==========================================================================
// 3. 酷曳介面實作 (Drag and Drop API)
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

// ==========================================================================
// 4. 動態生成池子內的 Checkbox 列表
// ==========================================================================
function renderFilterOptions(zone, zoneType, filterId) {
    const groupDiv = document.createElement('div');
    groupDiv.className = 'active-filter-group';
    groupDiv.id = `${zoneType}-group-${filterId}`;
    
    const options = getOptionsByFilterId(filterId);
    let title = getTitleByFilterId(filterId);

    let checkboxesHtml = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; border-bottom:1px solid #475569; padding-bottom:4px;">
            <strong style="color:#67e8f9;">🔍 ${title}</strong>
            <button onclick="removeFilterGroup('${zoneType}', '${filterId}')" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:0.8rem;">❌ 移除</button>
        </div>
        <div style="display:grid; grid-template-columns: repeat(2, 1fr); gap:6px; padding:8px 0;" id="${zoneType}-options-${filterId}">
    `;

    options.forEach(opt => {
        const displayValues = opt.text || opt.value || '';
        const inputVal = opt.value !== undefined ? opt.value : opt.text;

        checkboxesHtml += `
            <label style="font-size:0.85rem; display:flex; align-items:center; gap:4px; cursor:pointer;">
                <input type="checkbox" value="${inputVal}" data-text="${displayValues}" onchange="onCheckboxChange('${zoneType}', '${filterId}')">
                ${displayValues}
            </label>
        `;
    });
    checkboxesHtml += `</div>`;
    groupDiv.innerHTML = checkboxesHtml;
    zone.appendChild(groupDiv);

    if (filterId === 'town') handleTownSelect联动(zoneType);
}

function getOptionsByFilterId(id) {
    if (id === 'city') return Object.entries(rawData.mappings.city).map(([k,v]) => ({value: k, text: v}));
    if (id === 'town') return Object.entries(rawData.mappings.town).map(([k,v]) => ({value: k, text: v}));
    
    if (id === 'station_type') {
        if (rawData.mappings && rawData.mappings.station_type) {
            return Object.entries(rawData.mappings.station_type).map(([k, v]) => ({
                value: k,
                text: v
            }));
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
    if (id === 'public') return ['有對外提供', '沒有對外提供'].map(v => ({value: v, text: v}));
    if (id === 'status') return ['正式上架站', '未上架'].map(v => ({value: v, text: v}));
    return [];
}

function getTitleByFilterId(id) {
    const titles = { unit: '所屬單位', transport: '傳輸方式', city: '縣市', town: '鄉鎮市區', 'weather-freq': '氣象頻率', 'rain-freq': '雨量頻率', vendor: '維護廠商', public: '對外提供', station_type: '測站類型', 'regional-center': '區域站歸屬', status: '上架狀態' };
    return titles[id] || id;
}

// ==========================================================================
// 5. 跨維度核心篩選引擎與連動 (Filtering Engine)
// ==========================================================================
function onCheckboxChange(zoneType, filterId) {
    const container = document.getElementById(`${zoneType}-options-${filterId}`);
    const checkedValues = Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value);
    
    if (checkedValues.length > 0) {
        activeFilters[zoneType][filterId] = checkedValues;
    } else {
        delete activeFilters[zoneType][filterId];
    }

    if (filterId === 'city') handleTownSelect联动(zoneType);
    calculateStations();
}

function removeFilterGroup(zoneType, filterId) {
    const el = document.getElementById(`${zoneType}-group-${filterId}`);
    if (el) el.remove();
    delete activeFilters[zoneType][filterId];
    if (filterId === 'city') handleTownSelect联动(zoneType);
    calculateStations();
}

function handleTownSelect联动(zoneType) {
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

// ==========================================================================
// 6. 核心數據運算、表格渲染與 CSV 匯出
// ==========================================================================
function calculateStations() {
    if (!stationsArray.length) return;

    const hasTypeInInclude = activeFilters.include['station_type'] !== undefined;
    const hasTypeInExclude = activeFilters.exclude['station_type'] !== undefined;

    let filteredResults = stationsArray.filter(station => {
        if (hasTypeInInclude || hasTypeInExclude) {
            return true; 
        }
        return station.is_hub !== true && station.is_reg_center !== true;
    });

    Object.entries(activeFilters.include).forEach(([filterId, values]) => {
        filteredResults = filteredResults.filter(station => {
            if (filterId === 'city') return values.includes(station.city.toString());
            if (filterId === 'town') return values.includes(station.town.toString());
            if (filterId === 'station_type') {
                return station.station_type !== undefined && values.includes(station.station_type.toString());
            }
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
            if (filterId === 'city') matchExclude = values.includes(station.city.toString());
            else if (filterId === 'town') matchExclude = values.includes(station.town.toString());
            else if (filterId === 'station_type') {
                matchExclude = station.station_type !== undefined && values.includes(station.station_type.toString());
            }
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
    if (totalElement) {
        totalElement.innerText = filteredResults.length;
    }

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

        html += `
            <tr>
                <td>${displayCwbid}</td>
                <td>${s.n}</td>
                <td>${cityName}</td>
                <td>${townName}</td>
                <td><span style="font-size:0.8rem; background:#334155; padding:2px 6px; border-radius:4px; color:#38bdf8;">${displayAlt}</span></td>
            </tr>
        `;
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
        
        return [
            s.sid,
            s.cwbid || "",
            s.n,
            cityName,
            townName,
            s.alt !== undefined ? s.alt : "",
            s._derivedTransport,
            s._derivedUnit,
            s._derivedVendor
        ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(","); 
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