"use strict";
(() => {
    const $ = id => document.getElementById(id);
    const ui = {
        formulaUnits: $("formulaUnits"),
        waterCount: $("waterCount"), autoPlay: $("autoPlay"), reload: $("reload"),
        play: $("play"), first: $("first"), center: $("center"), speed: $("speed"),
        hydration: $("hydration"), bonds: $("bonds"), status: $("status"),
        canvas: $("canvas"), timeline: $("timeline"), frameLabel: $("frameLabel"),
        meta: $("meta"), metrics: $("metrics"), warning: $("warning")
    };
    const ctx = ui.canvas.getContext("2d");
    const FILE_MAP = Object.freeze({
        "1|36": "1式単位_36(12-12-12)分子.json",
        "1|64": "1式単位_64(25-25-14)分子.json",
        "1|100": "1式単位_100(34-34-32)分子.json",
        "2|36": "2式単位_36(12-12-12)分子.json",
        "2|64": "2式単位_64(25-25-14)分子.json",
        "2|100": "2式単位_100(34-34-32)分子.json",
        "3|36": "3式単位_36(12-12-12)分子.json",
        "3|64": "3式単位_64(25-25-14)分子.json",
        "3|100": "3式単位_100(34-34-32)分子.json",
        "4|36": "4式単位_36(12-12-12)分子.json",
        "4|64": "4式単位_64(25-25-14)分子.json",
        "4|100": "4式単位_100(34-34-32)分子.json",
        "6|36": "6式単位_36(12-12-12)分子.json",
        "6|64": "6式単位_64(25-25-14)分子.json",
        "6|100": "6式単位_100(34-34-32)分子.json",
        "8|36": "8式単位_36(12-12-12)分子.json",
        "8|64": "8式単位_64(25-25-14)分子.json",
        "8|100": "8式単位_100(34-34-32)分子.json"
    });
    const DISPLAY = Object.freeze({
        paddingRatio: 0.88, layerShiftPx: 10,
        colors: { O: "#7b8794", H: "#c5ccd3", Na: "#e53935", Cl: "#e53935", "?": "#607d8b" },
        borders: { O: "#45515e", H: "#6b7682", Na: "#8e0000", Cl: "#8e0000", "?": "#263238" },
        radii: { O: 10, H: 6, Na: 15, Cl: 15, "?": 5 },
        bondColor: "#666", boxBorderColor: "#111",
        hydratedColor: "#1976d2", hydratedBorderColor: "#0d47a1",
        hydrationLineColor: "rgba(96,125,139,.72)", hydrationLineWidth: 1.5,
        hydrationLineDash: [6, 5]
    });
    const state = {
        data: null, sourceName: "", frame: 0, playing: false, lastTimestamp: 0,
        accumulator: 0, zoom: 1, panX: 0, panY: 0, dragging: false, lastX: 0, lastY: 0,
        waterByAtomId: new Map(), atomIndexById: new Map(), ionIndices: []
    };
    const finite = Number.isFinite;
    const escapeHtml = value => String(value ?? "-").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
    function message(text, error = false) {
        ui.status.textContent = text;
        ui.status.className = "status" + (error ? " error" : "");
    }
    function classify(atom) {
        const text = String(atom.type ?? atom.role ?? atom.particleCategory ?? "").toLowerCase();
        if (text.includes("sodium") || text === "na" || text.includes("na+")) return "Na";
        if (text.includes("chlor") || text === "cl" || text.includes("cl-")) return "Cl";
        if (text === "o" || text.includes("oxygen")) return "O";
        if (text === "h" || text.includes("hydrogen")) return "H";
        return "?";
    }
    function minimumImage(delta, length) {
        if (!finite(delta) || !finite(length) || length <= 0) throw new Error("周期変位が不正です。");
        return delta - length * Math.floor(delta / length + 0.5);
    }
    const periodicLerp = (a, b, t, length) => minimumImage(a + minimumImage(b - a, length) * t, length);
    function expectedFileName() {
        return FILE_MAP[`${ui.formulaUnits.value}|${ui.waterCount.value}`];
    }
    function validate(data) {
        const errors = [];
        const atoms = data?.topology?.atomTable;
        const frames = data?.frames;
        if (!Array.isArray(atoms) || !atoms.length) errors.push("atomTableがありません");
        if (!Array.isArray(frames) || !frames.length) errors.push("framesがありません");
        if (errors.length) return errors;
        let previousStep = -Infinity, previousTime = -Infinity;
        frames.forEach((frame, index) => {
            if (frame.x_m?.length !== atoms.length || frame.y_m?.length !== atoms.length) errors.push(`frame ${index}: 座標数不一致`);
            if (frame.x_m?.some(v => !finite(v)) || frame.y_m?.some(v => !finite(v))) errors.push(`frame ${index}: 非有限座標`);
            if (!finite(frame.boxLengthX_m) || frame.boxLengthX_m <= 0 || !finite(frame.boxLengthY_m) || frame.boxLengthY_m <= 0) errors.push(`frame ${index}: 周期セル不正`);
            if (frame.step <= previousStep || frame.time_s <= previousTime) errors.push(`frame ${index}: step/time不正`);
            previousStep = frame.step; previousTime = frame.time_s;
        });
        return errors.slice(0, 20);
    }
    function verifySelectedConditions(data) {
        const fixed = data.metadata?.fixedConditions ?? {};
        const expectedUnits = Number(ui.formulaUnits.value);
        const expectedWater = Number(ui.waterCount.value);
        const actualUnits = Number(fixed.naClFormulaUnitCount);
        const actualWater = Number(fixed.actualWaterMoleculeCount ?? fixed.selectedWaterMoleculeCount);
        if (actualUnits !== expectedUnits || actualWater !== expectedWater) {
            throw new Error(`条件不一致: 選択=${expectedUnits}式単位・水${expectedWater}分子 / JSON=${actualUnits}式単位・水${actualWater}分子`);
        }
    }
    function interpolatedPosition() {
        const frames = state.data.frames;
        const i = Math.floor(state.frame), j = Math.min(i + 1, frames.length - 1), t = state.frame - i;
        const a = frames[i], b = frames[j], lengthX = a.boxLengthX_m, lengthY = a.boxLengthY_m;
        const x = a.x_m.map((value, index) => periodicLerp(value, b.x_m[index], t, lengthX));
        const y = a.y_m.map((value, index) => periodicLerp(value, b.y_m[index], t, lengthY));
        for (const water of state.data.topology.waterTable ?? []) {
            const oxygen = state.atomIndexById.get(water.oxygenAtomId);
            const hydrogens = [state.atomIndexById.get(water.hydrogen1AtomId), state.atomIndexById.get(water.hydrogen2AtomId)];
            if (oxygen === undefined || hydrogens.some(index => index === undefined)) continue;
            for (const hydrogen of hydrogens) {
                x[hydrogen] = x[oxygen] + minimumImage(x[hydrogen] - x[oxygen], lengthX);
                y[hydrogen] = y[oxygen] + minimumImage(y[hydrogen] - y[oxygen], lengthY);
            }
        }
        return { frame: a, x, y, lengthX, lengthY };
    }
    function resize() {
        const rect = ui.canvas.getBoundingClientRect();
        const ratio = Math.min(devicePixelRatio || 1, 2);
        ui.canvas.width = Math.round(rect.width * ratio);
        ui.canvas.height = Math.round(rect.height * ratio);
        draw();
    }
    function draw() {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, ui.canvas.width, ui.canvas.height);
        if (!state.data) return;
        const p = interpolatedPosition(), atoms = state.data.topology.atomTable, waters = state.data.topology.waterTable ?? [];
        const width = ui.canvas.width, height = ui.canvas.height, ratio = Math.min(devicePixelRatio || 1, 2);
        const scale = Math.min(width / p.lengthX, height / p.lengthY) * DISPLAY.paddingRatio * state.zoom;
        const cellWidth = p.lengthX * scale, cellHeight = p.lengthY * scale;
        const cellLeft = width / 2 - cellWidth / 2, cellTop = height / 2 - cellHeight / 2;
        const layerShift = index => Number(atoms[index]?.layerIndex ?? 0) * DISPLAY.layerShiftPx * ratio;
        const panWorldX = minimumImage(state.panX / scale, p.lengthX);
        const panWorldY = minimumImage(-state.panY / scale, p.lengthY);
        const wrapX = value => minimumImage(value + panWorldX, p.lengthX);
        const wrapY = value => minimumImage(value + panWorldY, p.lengthY);
        const px = (value, index) => width / 2 + value * scale + layerShift(index);
        const py = (value, index) => height / 2 - value * scale - layerShift(index);
        const imageOffsets = [];
        for (const imageX of [-1, 0, 1]) for (const imageY of [-1, 0, 1]) imageOffsets.push({ x: imageX * p.lengthX, y: imageY * p.lengthY });
        const hydratedIds = new Set(p.frame.hydratedWaterIds ?? []), hydratedAtoms = new Set();
        for (const [atomId, waterId] of state.waterByAtomId) if (hydratedIds.has(waterId)) hydratedAtoms.add(atomId);
        const drawAtom = (index, offsetX, offsetY) => {
            const atom = atoms[index], category = classify(atom), hydrated = ui.hydration.checked && hydratedAtoms.has(atom.id);
            const radius = Math.max(2 * ratio, DISPLAY.radii[category] * ratio * Math.min(state.zoom, 2));
            ctx.beginPath(); ctx.arc(px(wrapX(p.x[index]) + offsetX, index), py(wrapY(p.y[index]) + offsetY, index), radius, 0, Math.PI * 2);
            ctx.fillStyle = hydrated ? DISPLAY.hydratedColor : DISPLAY.colors[category]; ctx.fill();
            ctx.strokeStyle = hydrated ? DISPLAY.hydratedBorderColor : DISPLAY.borders[category]; ctx.lineWidth = Math.max(1, ratio); ctx.stroke();
        };
        ctx.save(); ctx.beginPath(); ctx.rect(cellLeft, cellTop, cellWidth, cellHeight); ctx.clip();
        if (ui.bonds.checked) {
            ctx.save(); ctx.strokeStyle = DISPLAY.bondColor; ctx.lineWidth = 1.2 * ratio;
            for (const water of waters) {
                const oxygen = state.atomIndexById.get(water.oxygenAtomId);
                const hydrogens = [state.atomIndexById.get(water.hydrogen1AtomId), state.atomIndexById.get(water.hydrogen2AtomId)];
                if (oxygen === undefined || hydrogens.some(index => index === undefined)) continue;
                const ox = wrapX(p.x[oxygen]), oy = wrapY(p.y[oxygen]);
                for (const hydrogen of hydrogens) {
                    const hx = ox + minimumImage(p.x[hydrogen] - p.x[oxygen], p.lengthX);
                    const hy = oy + minimumImage(p.y[hydrogen] - p.y[oxygen], p.lengthY);
                    for (const offset of imageOffsets) { ctx.beginPath(); ctx.moveTo(px(ox + offset.x, oxygen), py(oy + offset.y, oxygen)); ctx.lineTo(px(hx + offset.x, hydrogen), py(hy + offset.y, hydrogen)); ctx.stroke(); }
                }
            }
            ctx.restore();
        }
        if (ui.hydration.checked && state.ionIndices.length && hydratedIds.size) {
            const links = Array.isArray(p.frame.hydrationLinks) ? p.frame.hydrationLinks : [];
            ctx.save(); ctx.strokeStyle = DISPLAY.hydrationLineColor; ctx.lineWidth = DISPLAY.hydrationLineWidth * ratio;
            ctx.setLineDash(DISPLAY.hydrationLineDash.map(value => value * ratio)); ctx.lineCap = "round";
            for (const link of links) {
                const ion = state.atomIndexById.get(link.ionAtomId), oxygen = state.atomIndexById.get(link.oxygenAtomId);
                if (ion === undefined || oxygen === undefined) continue;
                const ix = wrapX(p.x[ion]), iy = wrapY(p.y[ion]);
                const ox = ix + minimumImage(p.x[oxygen] - p.x[ion], p.lengthX);
                const oy = iy + minimumImage(p.y[oxygen] - p.y[ion], p.lengthY);
                for (const offset of imageOffsets) { ctx.beginPath(); ctx.moveTo(px(ix + offset.x, ion), py(iy + offset.y, ion)); ctx.lineTo(px(ox + offset.x, oxygen), py(oy + offset.y, oxygen)); ctx.stroke(); }
            }
            ctx.restore();
        }
        const waterAtoms = [], ions = [];
        atoms.forEach((atom, index) => (["Na", "Cl"].includes(classify(atom)) ? ions : waterAtoms).push(index));
        for (const offset of imageOffsets) for (const index of waterAtoms) drawAtom(index, offset.x, offset.y);
        for (const offset of imageOffsets) for (const index of ions) drawAtom(index, offset.x, offset.y);
        ctx.restore();
        ctx.save(); ctx.strokeStyle = DISPLAY.boxBorderColor; ctx.lineWidth = Math.max(1, ratio); ctx.strokeRect(cellLeft, cellTop, cellWidth, cellHeight); ctx.restore();
        updateMetrics(p.frame);
    }
    function updateMetrics(frame) {
        const index = Math.floor(state.frame), diagnostic = frame.diagnostics ?? {};
        ui.frameLabel.textContent = `${index + 1} / ${state.data.frames.length}`; ui.timeline.value = index;
        ui.metrics.innerHTML = [
            ["step", frame.step], ["時間", finite(frame.time_s) ? `${(frame.time_s * 1e12).toFixed(3)} ps` : "-"],
            ["温度", finite(frame.instantaneousTemperature_K) ? `${frame.instantaneousTemperature_K.toFixed(2)} K` : "-"],
            ["フェーズ", frame.phase], ["Na⁺水和数", finite(diagnostic.sodiumHydrationCount) ? diagnostic.sodiumHydrationCount.toFixed(2) : "-"],
            ["Cl⁻水和数", finite(diagnostic.chlorideHydrationCount) ? diagnostic.chlorideHydrationCount.toFixed(2) : "-"], ["離脱候補", diagnostic.detachingIonCount ?? "-"]
        ].map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
    }
    function updateMetadata() {
        const metadata = state.data.metadata ?? {}, fixed = metadata.fixedConditions ?? {}, recording = metadata.recording ?? {};
        ui.meta.innerHTML = [
            ["読込ファイル", state.sourceName], ["設定水分子", fixed.selectedWaterMoleculeCount], ["実水分子", fixed.actualWaterMoleculeCount],
            ["NaCl式単位", fixed.naClFormulaUnitCount], ["温度", finite(fixed.selectedFinalTargetTemperature_K) ? `${fixed.selectedFinalTargetTemperature_K.toFixed(2)} K` : "-"],
            ["周期セルX", finite(fixed.boxLengthX_m) ? `${(fixed.boxLengthX_m * 1e9).toFixed(3)} nm` : "-"],
            ["周期セルY", finite(fixed.boxLengthY_m) ? `${(fixed.boxLengthY_m * 1e9).toFixed(3)} nm` : "-"], ["フレーム", state.data.frames.length],
            ["記録step", `${recording.actualStartStep ?? "-"}～${recording.actualEndStep ?? "-"}`]
        ].map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
        ui.warning.textContent = metadata.quantitativeDynamicsValid === false
            ? "この軌道は教材表示用です。定量的な平衡・拡散・速度論評価には使用しません。"
            : "周期境界条件と最小イメージ規約を適用して再生します。";
    }
    function initializeLoadedData(data, sourceName) {
        const errors = validate(data); if (errors.length) throw new Error(errors.join(" / "));
        verifySelectedConditions(data);
        state.data = data; state.sourceName = sourceName; state.frame = 0; state.zoom = 1; state.panX = state.panY = 0;
        state.waterByAtomId.clear(); state.atomIndexById.clear();
        data.topology.atomTable.forEach((atom, index) => state.atomIndexById.set(atom.id, index));
        for (const water of data.topology.waterTable ?? []) for (const atomId of [water.oxygenAtomId, water.hydrogen1AtomId, water.hydrogen2AtomId]) state.waterByAtomId.set(atomId, water.id);
        state.ionIndices = data.topology.atomTable.map((atom, index) => [atom, index]).filter(([atom]) => ["Na", "Cl"].includes(classify(atom))).map(([, index]) => index);
        if (!state.ionIndices.length) throw new Error("Na⁺またはCl⁻が見つかりません");
        updateMetadata(); ui.timeline.max = data.frames.length - 1;
        for (const control of [ui.play, ui.first, ui.center]) control.disabled = false; ui.timeline.disabled = false;
        message(`${sourceName} を読み込みました。再生可能です。`); draw();
        if (ui.autoPlay.checked) { state.playing = false; togglePlayback(); }
    }
    async function loadFile(file) {
        message(`${file.name} を読み込み中です。`);
        initializeLoadedData(JSON.parse(await file.text()), file.name);
    }
    async function loadSelectedTrajectory() {
        const filename = expectedFileName();
        if (!filename) {
            message("この条件のデータはありません。", true);
            return;
        }

        state.playing = false;
        ui.play.textContent = "再生";
        ui.reload.disabled = true;
        ui.formulaUnits.disabled = true;
        ui.waterCount.disabled = true;

        try {
            message(`データを読み込んでいます…\n${filename}`);
            const response = await fetch(encodeURI(filename), { cache: "force-cache" });
            if (!response.ok) {
                throw new Error(`データ取得エラー（HTTP ${response.status}）`);
            }
            initializeLoadedData(await response.json(), filename);
        } catch (error) {
            state.data = null;
            draw();
            message(`データを読み込めませんでした。先生に知らせてください。\n${error.message}`, true);
        } finally {
            ui.reload.disabled = false;
            ui.formulaUnits.disabled = false;
            ui.waterCount.disabled = false;
        }
    }
    function animate(timestamp) {
        if (!state.playing) return;
        if (!state.lastTimestamp) state.lastTimestamp = timestamp;
        state.accumulator += Math.min(100, timestamp - state.lastTimestamp) * Number(ui.speed.value); state.lastTimestamp = timestamp;
        while (state.accumulator >= 1000 / 30) {
            state.frame += 1; state.accumulator -= 1000 / 30;
            if (state.frame >= state.data.frames.length - 1) { state.frame = state.data.frames.length - 1; state.playing = false; ui.play.textContent = "再生"; break; }
        }
        draw(); if (state.playing) requestAnimationFrame(animate);
    }
    function togglePlayback() {
        if (!state.data) return;
        state.playing = !state.playing; ui.play.textContent = state.playing ? "一時停止" : "再生"; state.lastTimestamp = 0;
        if (state.playing) { if (state.frame >= state.data.frames.length - 1) state.frame = 0; requestAnimationFrame(animate); }
    }
    ui.reload.addEventListener("click", loadSelectedTrajectory);
    ui.play.addEventListener("click", togglePlayback);
    ui.first.addEventListener("click", () => { state.playing = false; state.frame = 0; ui.play.textContent = "再生"; draw(); });
    ui.center.addEventListener("click", () => { state.panX = state.panY = 0; state.zoom = 1; draw(); });
    ui.timeline.addEventListener("input", () => { state.playing = false; ui.play.textContent = "再生"; state.frame = Number(ui.timeline.value); draw(); });
    ui.hydration.addEventListener("change", draw); ui.bonds.addEventListener("change", draw);
    ui.canvas.addEventListener("wheel", event => { event.preventDefault(); state.zoom = Math.max(.25, Math.min(8, state.zoom * Math.exp(-event.deltaY * .001))); draw(); }, { passive: false });
    ui.canvas.addEventListener("pointerdown", event => { state.dragging = true; state.lastX = event.clientX; state.lastY = event.clientY; ui.canvas.setPointerCapture(event.pointerId); });
    ui.canvas.addEventListener("pointermove", event => { if (!state.dragging) return; state.panX += (event.clientX - state.lastX) * (devicePixelRatio || 1); state.panY += (event.clientY - state.lastY) * (devicePixelRatio || 1); state.lastX = event.clientX; state.lastY = event.clientY; draw(); });
    ui.canvas.addEventListener("pointerup", () => { state.dragging = false; }); ui.canvas.addEventListener("pointercancel", () => { state.dragging = false; });
    window.addEventListener("resize", resize); resize(); loadSelectedTrajectory();
})();
