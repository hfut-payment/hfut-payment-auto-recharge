const HOUR_MS = 60 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * HOUR_MS;
const WINDOW_START = 6;
const WINDOW_END = 23;
const MAX_RECHARGE_YUAN = 999;
const OUTSIDE_WINDOW = "电费将在北京时间 06:00–23:00 检查并自动充值。";
const PENDING_NOTICE = "充值结果未确认，请核对账单状态";
const SERVICES = {
    regular: { title: "常规电费", icon: "power" },
    ac: { title: "空调电费", icon: "power" },
    shower: { title: "洗浴余额", icon: "water" },
    net: { title: "校园网费", icon: "network" }
};

function call(method, input, next, state) {
    return { effect: { type: "campus.recharge", method, input, next }, state };
}

function notice(title, detail, warning = true) {
    return { dialog: { title, detail, warning } };
}

function available(entry) {
    if (entry !== "regular" && entry !== "ac") return true;
    const hour = Math.floor((Date.now() + BEIJING_OFFSET_MS) / HOUR_MS) % 24;
    return hour >= WINDOW_START && hour < WINDOW_END;
}

function menu(event, entries = Object.keys(SERVICES), refreshOnReturn = "page") {
    if (event.profile?.campus === "hf" || event.fee?.campus === "hf") {
        return { title: "自动充值", detail: "当前支持宣城校区。" };
    }
    const electricOnly = refreshOnReturn === "fee.page";
    return {
        title: "自动充值",
        refreshOnReturn,
        detail: electricOnly
            ? "电费只在北京时间 06:00–23:00 检查并自动充值。失败后至少等 1 小时再试。"
            : "约每 15 分钟检查一次。电费只在北京时间 06:00–23:00 自动充值，洗浴和网费全天可用。失败后至少等 1 小时再试。",
        rows: entries.map(entry => ({
            title: SERVICES[entry].title, icon: SERVICES[entry].icon, event: entry + ".page",
            detail: event.job?.tasks?.[entry]?.enabled ? "已启用" : "未启用"
        }))
    };
}

function page(event, entry) {
    const service = SERVICES[entry];
    const storage = event.storage || {};
    const legacyMeter = entry === "regular" ? event.profile?.room?.regularMeter
        : entry === "ac" ? event.profile?.room?.acMeter : null;
    const legacy = legacyMeter && storage.room === legacyMeter ? {
        card: storage.card, balance: storage.electric, amount: storage.amount
    } : {};
    const values = storage[entry] || legacy;
    const status = event.job?.tasks?.[entry] || {};
    const rows = [{ title: "预览条件", detail: "查询当前余额", icon: "info", event: entry + ".preview" }];
    if (status.enabled) rows.push({ title: "停止自动充值", icon: "power", event: entry + ".page", job: "stop", jobKey: entry });
    rows.push({ title: status.enabled ? "重新授权规则" : "启用自动充值", icon: "power", event: entry + ".ready" });
    return {
        title: service.title + " · 自动充值",
        detail: "两个余额条件都满足时才会充值。支付密码可在主应用的「充值设置」中管理。修改规则后请重新授权。",
        status: status.last ? { title: "最近检查", detail: status.last, warning: status.warning === true } : undefined,
        autosave: entry + ".save",
        refreshOnReturn: entry + ".page",
        fields: [
            { key: "card", type: "number", title: "校园卡圈存后余额高于（元）", value: values.card || "20.00" },
            { key: "balance", type: "number", title: service.title + "低于（元）", value: values.balance || "5.00" },
            { key: "amount", type: "number", title: "每次充值金额（元）", value: values.amount || "5.00" }
        ],
        rows
    };
}

function parseMoney(value, precision) {
    const raw = String(value ?? "").trim();
    const format = new RegExp("^[0-9]{1,6}(?:\\.[0-9]{1," + precision + "})?$");
    if (!format.test(raw)) return null;
    const [whole, fraction = ""] = raw.split(".");
    return Number(whole) * 10 ** precision + Number(fraction.padEnd(precision, "0"));
}

function makeRule(input, target, entry) {
    const precision = entry === "shower" ? 3 : 2;
    const cardAfterSettlementAbove = parseMoney(input?.card, 2);
    const balance = parseMoney(input?.balance, precision);
    const cents = parseMoney(input?.amount, 2);
    if (!target?.kind || !target.id || cardAfterSettlementAbove === null || balance === null ||
        cents === null || cents < 1 || cents > MAX_RECHARGE_YUAN * 100) return null;
    return {
        target: { kind: target.kind, id: target.id },
        amount: (cents / 100).toFixed(2), card: String(input.card).trim(), balance: String(input.balance).trim(),
        limits: { cardAfterSettlementAbove, belowMilli: balance * (precision === 3 ? 1 : 10) }
    };
}

function outcome(background, title, status, warning = true) {
    return background ? { output: { status, warning } } : notice(title, status, warning);
}

function handle(event) {
    if (event.action === "fee.page") {
        if (event.profile?.campus === "hf" || event.fee?.campus === "hf") return menu(event);
        switch (event.fee?.kind) {
            case "electric": return menu(event, ["regular", "ac"], "fee.page");
            case "water": return page(event, "shower");
            case "network": return page(event, "net");
            default: return menu(event);
        }
    }
    const [entry, step] = event.action === "timer" ? [event.task, "timer"] : event.action.split(".");
    if (!Object.prototype.hasOwnProperty.call(SERVICES, entry)) return menu(event);
    const title = SERVICES[entry].title;
    const saved = event.storage?.[entry];
    const state = event.state || {};
    const background = step === "timer" || state.background === true;
    if (event.profile?.campus === "hf") return outcome(background, title, "当前校区不支持此规则");
    switch (step) {
        case "page": return page(event, entry);
        case "save": case "preview":
            return call("balances", { entry, resolve: true }, entry + ".resolve", { step, input: event.input });
        case "resolve": {
            const target = event.result?.target;
            const invalid = message => state.step === "save" ? { output: { error: message } } : notice(title, message);
            if (!target) return invalid("请先到费用查询设置里确认宿舍或洗浴账户。");
            const rule = makeRule(state.input, target, entry);
            if (!rule) return invalid("请核对两个余额阈值和 ¥0.01–¥" + MAX_RECHARGE_YUAN + " 的充值金额。");
            if (state.step === "save" || state.step === "ready") return { effect: {
                type: "storage.set", values: { [entry]: rule }, next: entry + (state.step === "save" ? ".saved" : ".check")
            } };
            return call("balances", { entry, ...rule }, entry + ".evaluate", { rule, background: false });
        }
        case "saved": return { output: {} };
        case "ready":
            if (!saved?.target) return call("balances", { entry, resolve: true }, entry + ".resolve", { step: "ready", input: event.input });
            return call("status", {}, entry + ".review");
        case "check":
            return call("status", {}, entry + ".review");
        case "review": {
            if (event.result?.pending === true) return notice("有一笔充值待核对", PENDING_NOTICE);
            if (!saved?.target || event.result?.passwordSaved !== true)
                return notice(title, "请先保存充值规则，并在主应用的「充值设置」里保存支付密码。");
            return { dialog: {
                title: "核对自动充值规则",
                detail: "校园卡圈存后余额高于 ¥" + saved.card + "，且" + title + "低于 ¥" + saved.balance + " 时，每次充值 ¥" + saved.amount + "。",
                actions: [{ title: "启用规则", event: entry + ".page", job: "start", jobKey: entry, spend: true }]
            } };
        }
        case "timer":
            if (!available(entry)) return outcome(true, title, OUTSIDE_WINDOW, false);
            return call("status", {}, entry + ".preflight", { background: true });
        case "preflight": {
            if (event.result?.pending === true) return outcome(true, title, PENDING_NOTICE);
            if (!available(entry)) return outcome(true, title, OUTSIDE_WINDOW, false);
            if (event.result?.passwordSaved !== true) return outcome(true, title, "请先在主应用的「充值设置」里保存支付密码。");
            const rule = makeRule(saved, saved?.target, entry);
            if (!rule) return outcome(true, title, "规则不完整");
            return call("balances", { entry, ...rule }, entry + ".evaluate", { rule, background: true });
        }
        case "evaluate": {
            const rule = state.rule;
            const { card, cardPending, cardAfterSettlement, balanceMilli } = event.result || {};
            if (!rule || !Number.isSafeInteger(card) || !Number.isSafeInteger(balanceMilli))
                return outcome(background, title, event.result?.status || "无法确认两项余额");
            if (!Number.isSafeInteger(cardAfterSettlement) || !Number.isSafeInteger(cardPending))
                return outcome(background, title, "待圈存金额未返回或无效，无法确认校园卡圈存后余额。");
            const meetsThresholds = cardAfterSettlement > rule.limits.cardAfterSettlementAbove &&
                balanceMilli < rule.limits.belowMilli;
            const amount = parseMoney(rule.amount, 2);
            const debitWarning = cardAfterSettlement < amount ? "计入待圈存后余额不足，未提交充值" : "";
            if (!background) return notice(title + " · 条件预览",
                "校园卡圈存后 ¥" + (cardAfterSettlement / 100).toFixed(2) + "（实际 ¥" + (card / 100).toFixed(2) +
                (cardPending < 0 ? " − " : " + ") + "¥" + (Math.abs(cardPending) / 100).toFixed(2) + "）\n" +
                title + " ¥" + (balanceMilli / 1000).toFixed(entry === "shower" ? 3 : 2) + "。\n" +
                (!meetsThresholds ? "尚未满足全部条件。" : debitWarning || "已满足两项条件。"),
                !meetsThresholds || Boolean(debitWarning));
            if (!available(entry)) return outcome(true, title, OUTSIDE_WINDOW, false);
            if (!meetsThresholds) return outcome(true, title, "未达到全部条件", false);
            if (debitWarning) return outcome(true, title, debitWarning);
            return call("recharge", { entry, ...rule }, entry + ".result", { background: true });
        }
        case "result": {
            const result = event.result || {};
            const status = result.status || (result.paid ? "学校已确认充值" : PENDING_NOTICE);
            return outcome(true, title, result.orderId ? status + "\n订单号 " + result.orderId : status, result.paid !== true);
        }
        default: return outcome(background, title, "未识别的操作");
    }
}
