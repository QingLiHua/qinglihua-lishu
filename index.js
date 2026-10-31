import { SECRET_KEYS, writeSecret } from '/scripts/secrets.js';

const MODULE_ID = 'qingliStationHub';
const NONE_PROFILE_LABEL = '<None>';
const SWITCH_TIMEOUT_MS = 12_000;
const ADD_MODEL_VALUE = '__qsh_add_model__';
const MAX_SEEN_MESSAGES = 120;

const DEFAULT_SETTINGS = Object.freeze({
    favoriteStations: [],
    showLauncher: true,
    stationMeta: {},
    recentModels: {},
    usageStats: {},
});

let settings;
let switching = false;
let initialized = false;
let uiObserver;

function getContext() {
    return globalThis.SillyTavern?.getContext?.();
}

function notify(type, message, title = '') {
    const notifier = globalThis.toastr?.[type];
    if (typeof notifier === 'function') {
        notifier(message, title, { timeOut: 2200, preventDuplicates: true });
    }
}

function normalizeEndpoint(value) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return '';

    try {
        const url = new URL(trimmed);
        const cleanPath = url.pathname.replace(/\/+$/, '');
        return `${url.origin}${cleanPath}${url.search}`;
    } catch {
        return trimmed.replace(/\/+$/, '');
    }
}

function isHttpEndpoint(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function parseModels(value) {
    return [...new Set(
        String(value ?? '')
            .split(/[\n,，]+/u)
            .map(model => model.trim())
            .filter(Boolean),
    )];
}

function endpointKey(profile) {
    const endpoint = normalizeEndpoint(profile?.['api-url']);
    if (endpoint) return `url:${endpoint.toLowerCase()}`;
    return `api:${String(profile?.api || profile?.mode || 'unknown').toLowerCase()}`;
}

function endpointHost(endpoint) {
    try {
        return new URL(endpoint).host;
    } catch {
        return endpoint || '其他连接';
    }
}

function inferStationName(profile, endpoint) {
    if (profile?.qingliStationName) return String(profile.qingliStationName);

    const host = endpointHost(endpoint).toLowerCase();
    if (host.endsWith('jiuzhan.top')) return '九站';
    if (host.endsWith('eazydata.org')) return 'EazyData';

    const profileName = String(profile?.name || '').trim();
    const explicitPrefix = profileName.split(/\s*[·｜|]\s*/u)[0]?.trim();
    if (explicitPrefix && explicitPrefix !== profileName) return explicitPrefix;

    return endpointHost(endpoint) || profileName || '其他连接';
}

function modelLabel(profile) {
    return String(profile?.model || profile?.name || '默认模型');
}

function stationIdForProfile(profile) {
    return profile?.qingliStationId || endpointKey(profile);
}

function saveSettings() {
    getContext()?.saveSettingsDebounced?.();
}

function getStationMeta(stationId) {
    if (!settings) return {};
    settings.stationMeta ??= {};
    settings.stationMeta[stationId] ??= {};
    return settings.stationMeta[stationId];
}

function getConnectionManager() {
    const context = getContext();
    const extensionSettings = context?.extensionSettings;
    if (!extensionSettings) return null;

    extensionSettings.connectionManager ??= { profiles: [], selectedProfile: null };
    extensionSettings.connectionManager.profiles ??= [];
    return extensionSettings.connectionManager;
}

function groupProfiles(profiles) {
    const groups = new Map();

    for (const profile of profiles) {
        if (!profile?.id) continue;
        const endpoint = normalizeEndpoint(profile['api-url']);
        const key = stationIdForProfile(profile);
        const existing = groups.get(key);

        if (existing) {
            existing.profiles.push(profile);
            if (profile.qingliStationName) existing.name = String(profile.qingliStationName);
            continue;
        }

        groups.set(key, {
            id: key,
            name: inferStationName(profile, endpoint),
            endpoint,
            modelPlazaUrl: profile.qingliModelPlazaUrl || '',
            profiles: [profile],
        });
    }

    const favorites = new Set(settings?.favoriteStations || []);
    return [...groups.values()]
        .map(group => {
            const meta = settings?.stationMeta?.[group.id] || {};
            const recent = settings?.recentModels?.[group.id] || [];
            const recentIndex = new Map(recent.map((model, index) => [model, index]));
            const profilesSorted = group.profiles.slice().sort((a, b) => {
                const aIndex = recentIndex.has(modelLabel(a)) ? recentIndex.get(modelLabel(a)) : Number.MAX_SAFE_INTEGER;
                const bIndex = recentIndex.has(modelLabel(b)) ? recentIndex.get(modelLabel(b)) : Number.MAX_SAFE_INTEGER;
                return aIndex - bIndex || modelLabel(a).localeCompare(modelLabel(b));
            });

            return {
                ...group,
                name: meta.name || group.name,
                modelPlazaUrl: meta.modelPlazaUrl || group.modelPlazaUrl || '',
                profiles: profilesSorted,
                favorite: favorites.has(group.id),
                balance: meta.balance ?? null,
                balanceUnit: meta.balanceUnit || '',
            };
        })
        .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
}

function uniqueProfileName(baseName, profiles) {
    const used = new Set(profiles.map(profile => String(profile.name)));
    if (!used.has(baseName)) return baseName;

    let index = 2;
    while (used.has(`${baseName} (${index})`)) index += 1;
    return `${baseName} (${index})`;
}

function escapeAttribute(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function formatTokens(value) {
    const number = Number(value) || 0;
    if (number < 1_000) return String(number);
    if (number < 1_000_000) return `${(number / 1_000).toFixed(number < 10_000 ? 1 : 0)}k`;
    return `${(number / 1_000_000).toFixed(number < 10_000_000 ? 1 : 0)}m`;
}

function localDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function emptyUsageCounter() {
    return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function getUsageBucket(stationId) {
    settings.usageStats ??= {};
    settings.usageStats[stationId] ??= {
        total: emptyUsageCounter(),
        days: {},
        seenMessages: [],
    };
    const bucket = settings.usageStats[stationId];
    bucket.total ??= emptyUsageCounter();
    bucket.days ??= {};
    bucket.seenMessages ??= [];
    return bucket;
}

function addUsage(stationId, usage, { countCall = false } = {}) {
    if (!stationId) return;
    const bucket = getUsageBucket(stationId);
    const day = localDayKey();
    bucket.days[day] ??= emptyUsageCounter();

    for (const target of [bucket.total, bucket.days[day]]) {
        if (countCall) target.calls = (Number(target.calls) || 0) + 1;
        target.promptTokens = (Number(target.promptTokens) || 0) + (Number(usage?.promptTokens) || 0);
        target.completionTokens = (Number(target.completionTokens) || 0) + (Number(usage?.completionTokens) || 0);
        target.totalTokens = (Number(target.totalTokens) || 0) + (Number(usage?.totalTokens) || 0);
    }

    saveSettings();
}

function usageFromObject(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return null;
    seen.add(value);

    const promptTokens = Number(value.prompt_tokens ?? value.promptTokens ?? value.input_tokens ?? value.inputTokens ?? 0);
    const completionTokens = Number(value.completion_tokens ?? value.completionTokens ?? value.output_tokens ?? value.outputTokens ?? 0);
    const explicitTotal = Number(value.total_tokens ?? value.totalTokens ?? 0);
    const fallbackTokenCount = Number(value.token_count ?? value.tokenCount ?? 0);
    const totalTokens = explicitTotal || promptTokens + completionTokens || fallbackTokenCount;

    if (Number.isFinite(totalTokens) && totalTokens > 0) {
        return {
            promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
            completionTokens: Number.isFinite(completionTokens) ? completionTokens : fallbackTokenCount,
            totalTokens,
        };
    }

    for (const key of ['usage', 'token_usage', 'tokenUsage', 'extra', 'data', 'response', 'message']) {
        const result = usageFromObject(value[key], depth + 1, seen);
        if (result) return result;
    }

    return null;
}

function selectedStationId() {
    const manager = getConnectionManager();
    const profile = manager?.profiles.find(item => item.id === manager.selectedProfile);
    return profile ? stationIdForProfile(profile) : null;
}

function recordGenerationStarted() {
    const stationId = selectedStationId();
    if (!stationId) return;
    addUsage(stationId, null, { countCall: true });
    render();
}

function recordMessageUsage(...args) {
    const stationId = selectedStationId();
    const context = getContext();
    if (!stationId || !context) return;

    const index = args.find(value => Number.isInteger(value) && value >= 0 && value < context.chat?.length);
    const message = Number.isInteger(index) ? context.chat[index] : context.chat?.at?.(-1);
    if (!message) return;

    const bucket = getUsageBucket(stationId);
    const messageKey = String(message.id ?? message.send_date ?? `${index ?? context.chat.length - 1}:${String(message.mes || '').length}`);
    if (bucket.seenMessages.includes(messageKey)) return;

    const usage = usageFromObject(message);
    if (!usage) return;

    bucket.seenMessages.push(messageKey);
    bucket.seenMessages = bucket.seenMessages.slice(-MAX_SEEN_MESSAGES);
    addUsage(stationId, usage);
    render();
}

function recordRecentModel(stationId, model) {
    if (!stationId || !model) return;
    settings.recentModels ??= {};
    const recent = settings.recentModels[stationId] || [];
    settings.recentModels[stationId] = [model, ...recent.filter(item => item !== model)].slice(0, 80);
    saveSettings();
}

function usageSummary(stationId) {
    const bucket = settings?.usageStats?.[stationId];
    const today = bucket?.days?.[localDayKey()] || emptyUsageCounter();
    const total = bucket?.total || emptyUsageCounter();
    const todayText = today.totalTokens
        ? `今日 ${today.calls || 0} 次 · ${formatTokens(today.totalTokens)} tokens`
        : `今日 ${today.calls || 0} 次`;
    const totalText = total.totalTokens
        ? `累计 ${total.calls || 0} 次 · ${formatTokens(total.totalTokens)} tokens`
        : `累计 ${total.calls || 0} 次`;
    return { todayText, totalText };
}

function openExternal(url) {
    if (!isHttpEndpoint(url)) {
        notify('warning', '这个站子还没有设置可打开的链接。');
        return false;
    }
    globalThis.open(url, '_blank', 'noopener,noreferrer');
    return true;
}

function stationDashboardUrl(group) {
    const explicit = settings?.stationMeta?.[group.id]?.dashboardUrl;
    if (isHttpEndpoint(explicit)) return explicit;
    if (isHttpEndpoint(group.modelPlazaUrl)) {
        try {
            return new URL('/dashboard', group.modelPlazaUrl).toString();
        } catch {
            return group.modelPlazaUrl;
        }
    }
    return '';
}

function shortModelName(model) {
    const value = String(model || '').split('/').at(-1) || '';
    return value.length > 13 ? `${value.slice(0, 12)}…` : value;
}

function syncNativeProfileSelect() {
    const manager = getConnectionManager();
    const select = document.getElementById('connection_profiles');
    if (!manager || !(select instanceof HTMLSelectElement)) return;

    select.replaceChildren();
    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = NONE_PROFILE_LABEL;
    select.append(noneOption);

    const profiles = manager.profiles.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const profile of profiles) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name;
        select.append(option);
    }

    select.value = manager.selectedProfile || '';
}

function setBusy(isBusy, text = '') {
    switching = isBusy;
    const status = document.getElementById('qsh-status');
    if (status) status.textContent = text;

    document.querySelectorAll('.qsh-switch-button').forEach(button => {
        button.disabled = isBusy;
    });
}

function waitForProfileLoaded(context) {
    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };

        context.eventSource.once(context.eventTypes.CONNECTION_PROFILE_LOADED, finish);
        const timer = setTimeout(() => finish(null), SWITCH_TIMEOUT_MS);
    });
}

async function switchToProfile(profileId) {
    if (switching) return false;

    const context = getContext();
    const manager = getConnectionManager();
    const profile = manager?.profiles.find(item => item.id === profileId);
    if (!context || !manager || !profile) {
        notify('error', '没有找到这个连接配置。');
        return false;
    }

    syncNativeProfileSelect();
    const select = document.getElementById('connection_profiles');
    if (!(select instanceof HTMLSelectElement) || !select.querySelector(`option[value="${CSS.escape(profile.id)}"]`)) {
        notify('error', '酒馆的连接配置管理器没有加载，请确认 Connection Profiles 已启用。');
        return false;
    }

    try {
        setBusy(true, `正在切换到 ${profile.name}…`);
        const loaded = waitForProfileLoaded(context);
        select.value = profile.id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        const loadedName = await loaded;
        manager.selectedProfile = profile.id;
        recordRecentModel(stationIdForProfile(profile), modelLabel(profile));
        context.saveSettingsDebounced();

        if (!loadedName) {
            notify('warning', '配置已选择，但连接响应有点慢，可以再点一次重连。');
        } else {
            notify('success', `已经切到 ${profile.name}`);
        }

        render();
        return true;
    } catch (error) {
        console.error('[Lishu Model Hub] 切换失败', error);
        notify('error', error?.message || '切换失败，请检查站子配置。');
        return false;
    } finally {
        setBusy(false, '');
    }
}

function toggleFavorite(stationId) {
    const favorites = new Set(settings.favoriteStations || []);
    favorites.has(stationId) ? favorites.delete(stationId) : favorites.add(stationId);
    settings.favoriteStations = [...favorites];
    saveSettings();
    render();
}

async function deleteProfile(profileId) {
    const context = getContext();
    const manager = getConnectionManager();
    const profile = manager?.profiles.find(item => item.id === profileId);
    if (!context || !manager || !profile) return;

    const confirmed = globalThis.confirm(`移除“${profile.name}”吗？\n\n只会删除这个连接配置，不会删除酒馆里保存的 API Key。`);
    if (!confirmed) return;

    manager.profiles = manager.profiles.filter(item => item.id !== profile.id);
    if (manager.selectedProfile === profile.id) manager.selectedProfile = null;

    const stationId = stationIdForProfile(profile);
    const stationStillExists = manager.profiles.some(item => stationIdForProfile(item) === stationId);
    if (!stationStillExists) {
        delete settings.stationMeta?.[stationId];
        delete settings.recentModels?.[stationId];
        delete settings.usageStats?.[stationId];
        settings.favoriteStations = (settings.favoriteStations || []).filter(id => id !== stationId);
    }

    context.saveSettingsDebounced();
    syncNativeProfileSelect();
    await context.eventSource.emit(context.eventTypes.CONNECTION_PROFILE_DELETED, profile);

    if (!manager.selectedProfile) {
        const select = document.getElementById('connection_profiles');
        if (select instanceof HTMLSelectElement) {
            select.value = '';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    notify('success', `已移除 ${profile.name}`);
    render();
}

function clearAddForm() {
    for (const id of ['qsh-station-name', 'qsh-endpoint', 'qsh-api-key', 'qsh-models', 'qsh-model-plaza-url']) {
        const field = document.getElementById(id);
        if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.value = '';
    }
}

function showAddForm(show) {
    const form = document.getElementById('qsh-add-form');
    const editForm = document.getElementById('qsh-edit-form');
    const addButton = document.getElementById('qsh-show-add');
    if (!form) return;
    form.classList.toggle('qsh-hidden', !show);
    editForm?.classList.add('qsh-hidden');
    addButton?.classList.toggle('qsh-hidden', show);
    if (show) document.getElementById('qsh-station-name')?.focus();
}

async function addStation(event) {
    event.preventDefault();

    const context = getContext();
    const manager = getConnectionManager();
    if (!context || !manager) {
        notify('error', '连接配置管理器还没有加载。');
        return;
    }

    const name = String(document.getElementById('qsh-station-name')?.value || '').trim();
    const endpoint = normalizeEndpoint(document.getElementById('qsh-endpoint')?.value || '');
    const apiKey = String(document.getElementById('qsh-api-key')?.value || '').trim();
    const models = parseModels(document.getElementById('qsh-models')?.value || '');
    const modelPlazaUrl = normalizeEndpoint(document.getElementById('qsh-model-plaza-url')?.value || '');

    if (!name) {
        notify('warning', '先给站子起个名字，宝宝。');
        document.getElementById('qsh-station-name')?.focus();
        return;
    }
    if (!isHttpEndpoint(endpoint)) {
        notify('warning', 'API 地址要以 http:// 或 https:// 开头。');
        document.getElementById('qsh-endpoint')?.focus();
        return;
    }
    if (!models.length) {
        notify('warning', '至少填一个模型 ID。');
        document.getElementById('qsh-models')?.focus();
        return;
    }
    if (modelPlazaUrl && !isHttpEndpoint(modelPlazaUrl)) {
        notify('warning', '模型广场链接要以 http:// 或 https:// 开头。');
        document.getElementById('qsh-model-plaza-url')?.focus();
        return;
    }

    const matchingProfiles = manager.profiles.filter(profile => normalizeEndpoint(profile['api-url']) === endpoint);
    let secretId = matchingProfiles.find(profile => profile['secret-id'])?.['secret-id'] || null;

    const saveButton = document.getElementById('qsh-save-station');
    if (saveButton instanceof HTMLButtonElement) saveButton.disabled = true;

    try {
        if (apiKey) {
            secretId = await writeSecret(SECRET_KEYS.CUSTOM, apiKey, name);
            const apiKeyInput = document.getElementById('qsh-api-key');
            if (apiKeyInput instanceof HTMLInputElement) apiKeyInput.value = '';
        }

        if (!secretId) {
            notify('warning', '这是新站子，需要先填一次 API Key；以后给同一地址加模型就不用重复填了。');
            document.getElementById('qsh-api-key')?.focus();
            return;
        }

        const stationId = matchingProfiles.find(profile => profile.qingliStationId)?.qingliStationId
            || `station:${context.uuidv4()}`;
        const stationMeta = getStationMeta(stationId);
        stationMeta.name = name;
        stationMeta.modelPlazaUrl = modelPlazaUrl || stationMeta.modelPlazaUrl || '';
        for (const profile of matchingProfiles) {
            profile.qingliStationId = stationId;
            profile.qingliStationName = name;
            profile.qingliModelPlazaUrl = stationMeta.modelPlazaUrl;
        }
        const created = [];
        const duplicates = [];

        for (const model of models) {
            const existing = manager.profiles.find(profile =>
                normalizeEndpoint(profile['api-url']) === endpoint && String(profile.model) === model,
            );
            if (existing) {
                duplicates.push(model);
                continue;
            }

            const profile = {
                id: context.uuidv4(),
                mode: 'cc',
                name: uniqueProfileName(`${name} · ${model}`, manager.profiles),
                api: 'custom',
                'api-url': endpoint,
                model,
                'secret-id': secretId,
                exclude: [],
                qingliStationId: stationId,
                qingliStationName: name,
                qingliModelPlazaUrl: stationMeta.modelPlazaUrl,
            };

            manager.profiles.push(profile);
            created.push(profile);
        }

        if (!created.length) {
            context.saveSettingsDebounced();
            notify('info', duplicates.length ? '这些模型已经在梨枢里了。' : '没有新增配置。');
            render();
            return;
        }

        context.saveSettingsDebounced();
        syncNativeProfileSelect();
        for (const profile of created) {
            await context.eventSource.emit(context.eventTypes.CONNECTION_PROFILE_CREATED, profile);
        }

        clearAddForm();
        showAddForm(false);
        render();

        const suffix = duplicates.length ? `，跳过 ${duplicates.length} 个重复模型` : '';
        notify('success', `已添加 ${created.length} 个模型${suffix}`);

        const switchNow = document.getElementById('qsh-switch-after-save');
        if (!(switchNow instanceof HTMLInputElement) || switchNow.checked) {
            await switchToProfile(created[0].id);
        }
    } catch (error) {
        console.error('[Lishu Model Hub] 添加失败', error);
        notify('error', error?.message || '保存站子失败。');
    } finally {
        if (saveButton instanceof HTMLButtonElement) saveButton.disabled = false;
    }
}

function findStationGroup(stationId) {
    const manager = getConnectionManager();
    return manager ? groupProfiles(manager.profiles).find(group => group.id === stationId) : null;
}

async function addModelToStation(stationId, rawModel) {
    const context = getContext();
    const manager = getConnectionManager();
    const group = findStationGroup(stationId);
    const model = String(rawModel || '').trim();
    if (!context || !manager || !group) return false;
    if (!model) {
        notify('warning', '先填模型 ID。');
        return false;
    }

    const duplicate = group.profiles.find(profile => modelLabel(profile) === model);
    if (duplicate) {
        notify('info', '这个模型已经保存过了。');
        await switchToProfile(duplicate.id);
        return true;
    }

    const source = group.profiles.find(profile => profile['secret-id']) || group.profiles[0];
    if (!source?.['secret-id']) {
        notify('warning', '这个站子还没有保存 API Key，请先在“编辑站子”里补上。');
        return false;
    }

    const profile = {
        ...source,
        id: context.uuidv4(),
        name: uniqueProfileName(`${group.name} · ${model}`, manager.profiles),
        model,
        exclude: Array.isArray(source.exclude) ? [...source.exclude] : [],
        qingliStationId: group.id,
        qingliStationName: group.name,
        qingliModelPlazaUrl: group.modelPlazaUrl || '',
    };

    manager.profiles.push(profile);
    context.saveSettingsDebounced();
    syncNativeProfileSelect();
    await context.eventSource.emit(context.eventTypes.CONNECTION_PROFILE_CREATED, profile);
    render();
    notify('success', `已保存模型 ${model}`);
    await switchToProfile(profile.id);
    return true;
}

async function renameStation(stationId) {
    const context = getContext();
    const manager = getConnectionManager();
    const group = findStationGroup(stationId);
    if (!context || !manager || !group) return;

    const nextName = String(globalThis.prompt('给站子换个名字：', group.name) ?? '').trim();
    if (!nextName || nextName === group.name) return;

    const stationProfiles = new Set(group.profiles.map(profile => profile.id));
    const otherProfiles = manager.profiles.filter(profile => !stationProfiles.has(profile.id));
    for (const profile of group.profiles) {
        profile.qingliStationId = group.id;
        profile.qingliStationName = nextName;
        profile.name = uniqueProfileName(`${nextName} · ${modelLabel(profile)}`, otherProfiles);
        otherProfiles.push(profile);
    }
    getStationMeta(group.id).name = nextName;
    context.saveSettingsDebounced();
    syncNativeProfileSelect();
    for (const profile of group.profiles) {
        await context.eventSource.emit(context.eventTypes.CONNECTION_PROFILE_UPDATED, profile);
    }
    render();
    notify('success', `已经改名为 ${nextName}`);
}

function showEditStationForm(stationId) {
    const group = findStationGroup(stationId);
    const form = document.getElementById('qsh-edit-form');
    if (!group || !(form instanceof HTMLFormElement)) return;

    showAddForm(false);
    form.classList.remove('qsh-hidden');
    document.getElementById('qsh-show-add')?.classList.add('qsh-hidden');
    const values = {
        'qsh-edit-station-id': group.id,
        'qsh-edit-station-name': group.name,
        'qsh-edit-endpoint': group.endpoint,
        'qsh-edit-model-plaza-url': group.modelPlazaUrl || '',
        'qsh-edit-api-key': '',
    };
    for (const [id, value] of Object.entries(values)) {
        const field = document.getElementById(id);
        if (field instanceof HTMLInputElement) field.value = value;
    }
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    document.getElementById('qsh-edit-station-name')?.focus();
}

function hideEditStationForm() {
    const form = document.getElementById('qsh-edit-form');
    form?.classList.add('qsh-hidden');
    document.getElementById('qsh-show-add')?.classList.remove('qsh-hidden');
}

async function editStation(event) {
    event.preventDefault();
    const context = getContext();
    const manager = getConnectionManager();
    const stationId = String(document.getElementById('qsh-edit-station-id')?.value || '');
    const group = findStationGroup(stationId);
    if (!context || !manager || !group) return;

    const name = String(document.getElementById('qsh-edit-station-name')?.value || '').trim();
    const endpoint = normalizeEndpoint(document.getElementById('qsh-edit-endpoint')?.value || '');
    const modelPlazaUrl = normalizeEndpoint(document.getElementById('qsh-edit-model-plaza-url')?.value || '');
    const apiKey = String(document.getElementById('qsh-edit-api-key')?.value || '').trim();

    if (!name) {
        notify('warning', '站子名称不能为空。');
        return;
    }
    if (!isHttpEndpoint(endpoint)) {
        notify('warning', 'API 地址要以 http:// 或 https:// 开头。');
        return;
    }
    if (modelPlazaUrl && !isHttpEndpoint(modelPlazaUrl)) {
        notify('warning', '模型广场链接要以 http:// 或 https:// 开头。');
        return;
    }

    const saveButton = document.getElementById('qsh-save-edit');
    if (saveButton instanceof HTMLButtonElement) saveButton.disabled = true;

    try {
        let secretId = group.profiles.find(profile => profile['secret-id'])?.['secret-id'] || null;
        if (apiKey) secretId = await writeSecret(SECRET_KEYS.CUSTOM, apiKey, name);

        const stationProfiles = new Set(group.profiles.map(profile => profile.id));
        const otherProfiles = manager.profiles.filter(profile => !stationProfiles.has(profile.id));
        for (const profile of group.profiles) {
            profile.qingliStationId = group.id;
            profile.qingliStationName = name;
            profile.qingliModelPlazaUrl = modelPlazaUrl;
            profile['api-url'] = endpoint;
            if (secretId) profile['secret-id'] = secretId;
            profile.name = uniqueProfileName(`${name} · ${modelLabel(profile)}`, otherProfiles);
            otherProfiles.push(profile);
        }

        const meta = getStationMeta(group.id);
        meta.name = name;
        meta.modelPlazaUrl = modelPlazaUrl;
        context.saveSettingsDebounced();
        syncNativeProfileSelect();
        for (const profile of group.profiles) {
            await context.eventSource.emit(context.eventTypes.CONNECTION_PROFILE_UPDATED, profile);
        }
        hideEditStationForm();
        render();
        notify('success', '站子配置已经更新');
    } catch (error) {
        console.error('[Lishu Model Hub] 编辑站子失败', error);
        notify('error', error?.message || '编辑站子失败。');
    } finally {
        if (saveButton instanceof HTMLButtonElement) saveButton.disabled = false;
    }
}

async function deleteStation(stationId) {
    const context = getContext();
    const manager = getConnectionManager();
    const group = findStationGroup(stationId);
    if (!context || !manager || !group) return;

    const confirmed = globalThis.confirm(`删除站子“${group.name}”以及它保存的 ${group.profiles.length} 个模型吗？\n\n不会删除酒馆密钥库里的 API Key。`);
    if (!confirmed) return;

    const ids = new Set(group.profiles.map(profile => profile.id));
    manager.profiles = manager.profiles.filter(profile => !ids.has(profile.id));
    if (ids.has(manager.selectedProfile)) manager.selectedProfile = null;
    delete settings.stationMeta?.[group.id];
    delete settings.recentModels?.[group.id];
    delete settings.usageStats?.[group.id];
    settings.favoriteStations = (settings.favoriteStations || []).filter(id => id !== group.id);

    context.saveSettingsDebounced();
    syncNativeProfileSelect();
    for (const profile of group.profiles) {
        await context.eventSource.emit(context.eventTypes.CONNECTION_PROFILE_DELETED, profile);
    }
    render();
    notify('success', `已删除站子 ${group.name}`);
}

function createCard(group, currentProfileId) {
    const card = document.createElement('article');
    const isCurrentStation = group.profiles.some(profile => profile.id === currentProfileId);
    card.className = `qsh-card${group.favorite ? ' qsh-favorite' : ''}${isCurrentStation ? ' qsh-current-station' : ''}`;
    card.dataset.search = [group.name, group.endpoint, ...group.profiles.flatMap(p => [p.name, p.model])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    const header = document.createElement('div');
    header.className = 'qsh-card-header';

    const identity = document.createElement('div');
    identity.className = 'qsh-card-identity';
    const titleRow = document.createElement('div');
    titleRow.className = 'qsh-card-title-row';
    const statusDot = document.createElement('span');
    statusDot.className = `qsh-status-dot${isCurrentStation ? ' qsh-status-dot-active' : ''}`;
    statusDot.title = isCurrentStation ? '当前正在使用' : '未使用';
    const title = document.createElement('strong');
    title.textContent = group.name;
    titleRow.append(statusDot, title);
    if (isCurrentStation) {
        const currentBadge = document.createElement('span');
        currentBadge.className = 'qsh-current-badge';
        currentBadge.textContent = '使用中';
        titleRow.append(currentBadge);
    }
    const endpoint = document.createElement('span');
    endpoint.textContent = group.endpoint || group.profiles[0]?.api || '连接配置';
    endpoint.title = group.endpoint || '';
    identity.append(titleRow, endpoint);

    const headerSide = document.createElement('div');
    headerSide.className = 'qsh-card-header-side';
    const usage = usageSummary(group.id);
    const balance = document.createElement('button');
    balance.type = 'button';
    balance.className = 'qsh-balance';
    balance.title = group.balance == null
        ? `${usage.totalText}。该站暂未提供可用的余额接口，点击前往控制台查看。`
        : `${usage.totalText}。点击前往站子控制台。`;
    const balanceValue = group.balance == null ? '--' : `${group.balanceUnit}${group.balance}`;
    balance.innerHTML = `<span>剩余额度</span><strong>${escapeAttribute(balanceValue)}</strong><small>${escapeAttribute(usage.todayText)}</small>`;
    balance.addEventListener('click', () => {
        const dashboardUrl = stationDashboardUrl(group);
        if (!dashboardUrl) {
            notify('info', `${usage.totalText}；这个站子还没有设置控制台链接。`);
            return;
        }
        openExternal(dashboardUrl);
    });

    const favorite = document.createElement('button');
    favorite.type = 'button';
    favorite.className = 'qsh-icon-button';
    favorite.title = group.favorite ? '取消置顶' : '置顶站子';
    favorite.setAttribute('aria-label', favorite.title);
    favorite.innerHTML = `<i class="${group.favorite ? 'fa-solid' : 'fa-regular'} fa-star"></i>`;
    favorite.addEventListener('click', () => toggleFavorite(group.id));

    const menu = document.createElement('details');
    menu.className = 'qsh-card-menu';
    const menuToggle = document.createElement('summary');
    menuToggle.className = 'qsh-icon-button';
    menuToggle.title = '站子菜单';
    menuToggle.setAttribute('aria-label', menuToggle.title);
    menuToggle.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
    const menuPanel = document.createElement('div');
    menuPanel.className = 'qsh-card-menu-panel';

    const makeMenuButton = (icon, label, handler, danger = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = danger ? 'qsh-menu-danger' : '';
        button.innerHTML = `<i class="fa-solid ${icon}"></i><span>${label}</span>`;
        button.addEventListener('click', async event => {
            event.preventDefault();
            menu.open = false;
            await handler();
        });
        return button;
    };

    menu.append(menuToggle, menuPanel);
    const headerActions = document.createElement('div');
    headerActions.className = 'qsh-card-header-actions';
    headerActions.append(favorite, menu);
    headerSide.append(balance, headerActions);
    header.append(identity, headerSide);

    const controls = document.createElement('div');
    controls.className = 'qsh-card-controls';

    const select = document.createElement('select');
    select.className = 'text_pole qsh-model-select';
    select.setAttribute('aria-label', `${group.name} 模型`);
    for (const profile of group.profiles) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = modelLabel(profile);
        option.selected = profile.id === currentProfileId;
        select.append(option);
    }

    const addModelOption = document.createElement('option');
    addModelOption.value = ADD_MODEL_VALUE;
    addModelOption.textContent = '＋ 新增模型…';
    select.append(addModelOption);

    if (!group.profiles.some(profile => profile.id === currentProfileId)) {
        select.selectedIndex = 0;
    }
    let selectedProfileId = select.value;

    const switchButton = document.createElement('button');
    switchButton.type = 'button';
    switchButton.className = 'menu_button qsh-switch-button';
    switchButton.innerHTML = '<i class="fa-solid fa-bolt"></i><span>切换</span>';
    switchButton.addEventListener('click', () => switchToProfile(select.value));

    const plazaButton = document.createElement('button');
    plazaButton.type = 'button';
    plazaButton.className = 'menu_button qsh-plaza-button';
    plazaButton.innerHTML = group.modelPlazaUrl
        ? '<i class="fa-solid fa-store"></i><span>模型广场</span>'
        : '<i class="fa-solid fa-link"></i><span>设置广场</span>';
    plazaButton.addEventListener('click', () => {
        if (group.modelPlazaUrl) openExternal(group.modelPlazaUrl);
        else showEditStationForm(group.id);
    });

    const modelAddForm = document.createElement('form');
    modelAddForm.className = 'qsh-inline-model-form qsh-hidden';
    const modelInput = document.createElement('input');
    modelInput.className = 'text_pole';
    modelInput.type = 'text';
    modelInput.placeholder = '输入模型 ID';
    modelInput.autocomplete = 'off';
    const modelSave = document.createElement('button');
    modelSave.type = 'submit';
    modelSave.className = 'menu_button qsh-primary-button';
    modelSave.textContent = '保存并切换';
    const modelCancel = document.createElement('button');
    modelCancel.type = 'button';
    modelCancel.className = 'menu_button';
    modelCancel.textContent = '取消';
    modelAddForm.append(modelInput, modelSave, modelCancel);

    const hideModelForm = () => {
        modelAddForm.classList.add('qsh-hidden');
        modelInput.value = '';
        select.value = selectedProfileId;
    };
    modelCancel.addEventListener('click', hideModelForm);
    modelAddForm.addEventListener('submit', async event => {
        event.preventDefault();
        modelSave.disabled = true;
        try {
            const saved = await addModelToStation(group.id, modelInput.value);
            if (saved) hideModelForm();
        } finally {
            modelSave.disabled = false;
        }
    });

    const updateButtonState = () => {
        const isCurrent = select.value === currentProfileId;
        switchButton.disabled = isCurrent || switching;
        switchButton.classList.toggle('qsh-current-button', isCurrent);
        switchButton.querySelector('span').textContent = isCurrent ? '当前' : '切换';
    };
    select.addEventListener('change', () => {
        if (select.value === ADD_MODEL_VALUE) {
            select.value = selectedProfileId;
            modelAddForm.classList.remove('qsh-hidden');
            modelInput.focus();
            return;
        }
        selectedProfileId = select.value;
        updateButtonState();
    });
    updateButtonState();

    menuPanel.append(
        makeMenuButton('fa-pen', '重命名', () => renameStation(group.id)),
        makeMenuButton('fa-sliders', '编辑站子', () => showEditStationForm(group.id)),
        makeMenuButton('fa-trash-can', '删除当前模型', () => deleteProfile(select.value), true),
        makeMenuButton('fa-box-archive', '删除整个站子', () => deleteStation(group.id), true),
    );

    controls.append(select, switchButton, plazaButton);
    card.append(header, controls, modelAddForm);
    return card;
}

function renderCurrentProfile(manager) {
    const current = manager?.profiles.find(profile => profile.id === manager.selectedProfile);
    const currentLabel = document.getElementById('qsh-current-profile');
    const launcher = document.getElementById('qsh-launcher');
    const launcherLabel = document.getElementById('qsh-launcher-label');

    if (currentLabel) {
        currentLabel.textContent = current
            ? `${current.qingliStationName || inferStationName(current, current['api-url'])} · ${modelLabel(current)}`
            : '还没有选择连接';
    }

    if (launcher) {
        launcher.title = current ? `梨枢：${current.name}` : '打开梨枢';
        launcher.classList.toggle('qsh-connected', Boolean(current));
    }
    if (launcherLabel) {
        launcherLabel.textContent = current ? shortModelName(modelLabel(current)) : '';
        launcherLabel.classList.toggle('qsh-hidden', !current);
    }
}

function filterCards() {
    const query = String(document.getElementById('qsh-search')?.value || '').trim().toLowerCase();
    let visible = 0;

    document.querySelectorAll('.qsh-card').forEach(card => {
        const matches = !query || card.dataset.search?.includes(query);
        card.classList.toggle('qsh-hidden', !matches);
        if (matches) visible += 1;
    });

    const empty = document.getElementById('qsh-search-empty');
    if (empty) empty.classList.toggle('qsh-hidden', visible > 0 || !query);
}

function render() {
    const manager = getConnectionManager();
    if (!manager) return;

    renderCurrentProfile(manager);
    const list = document.getElementById('qsh-station-list');
    if (!list) return;

    list.replaceChildren();
    const groups = groupProfiles(manager.profiles);
    if (!groups.length) {
        const empty = document.createElement('div');
        empty.className = 'qsh-empty';
        empty.innerHTML = '<i class="fa-solid fa-plug-circle-plus"></i><strong>还没有站子</strong><span>点“添加站子”，把 API 地址、Key 和模型存一次，以后就只管点。</span>';
        list.append(empty);
    } else {
        for (const group of groups) list.append(createCard(group, manager.selectedProfile));
    }

    filterCards();
}

function openHub() {
    const overlay = document.getElementById('qsh-overlay');
    if (!overlay) return;
    render();
    if (typeof overlay.showPopover === 'function' && !overlay.matches(':popover-open')) {
        overlay.showPopover();
    }
}

function closeHub() {
    const overlay = document.getElementById('qsh-overlay');
    if (!overlay) return;
    if (typeof overlay.hidePopover === 'function' && overlay.matches(':popover-open')) {
        overlay.hidePopover();
    }
    document.body.classList.remove('qsh-modal-open');
    showAddForm(false);
    hideEditStationForm();
}

function modalMarkup() {
    return `
        <div id="qsh-overlay" class="qsh-overlay" popover="auto">
            <section class="qsh-dialog" role="dialog" aria-modal="true" aria-labelledby="qsh-title">
                <header class="qsh-dialog-header">
                    <div>
                        <div class="qsh-eyebrow">LISHU MODEL HUB</div>
                        <h2 id="qsh-title">梨枢</h2>
                        <p id="qsh-current-profile">还没有选择连接</p>
                    </div>
                    <button id="qsh-close" type="button" class="qsh-icon-button qsh-close" popovertarget="qsh-overlay" popovertargetaction="hide" aria-label="关闭">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </header>

                <div class="qsh-toolbar">
                    <label class="qsh-search-box">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input id="qsh-search" type="search" placeholder="搜索站子或模型" autocomplete="off">
                    </label>
                    <button id="qsh-show-add" type="button" class="menu_button qsh-primary-button">
                        <i class="fa-solid fa-plus"></i><span>添加站子</span>
                    </button>
                </div>

                <form id="qsh-add-form" class="qsh-add-form qsh-hidden">
                    <div class="qsh-form-title">
                        <strong>添加一个站子</strong>
                        <span>Key 只交给酒馆自己的密钥库，插件不会保存明文。</span>
                    </div>
                    <div class="qsh-form-grid">
                        <label>
                            <span>站子名称</span>
                            <input id="qsh-station-name" class="text_pole" type="text" placeholder="例如：九站" required>
                        </label>
                        <label>
                            <span>API 地址</span>
                            <input id="qsh-endpoint" class="text_pole" type="url" placeholder="https://example.com/v1" required>
                        </label>
                        <label class="qsh-wide-field">
                            <span>模型广场链接（可选）</span>
                            <input id="qsh-model-plaza-url" class="text_pole" type="url" placeholder="https://example.com/pricing">
                        </label>
                        <label class="qsh-wide-field">
                            <span>API Key</span>
                            <input id="qsh-api-key" class="text_pole" type="password" placeholder="新站子必填；同一地址加模型可留空" autocomplete="new-password">
                        </label>
                        <label class="qsh-wide-field">
                            <span>初始模型 ID</span>
                            <textarea id="qsh-models" class="text_pole" rows="3" placeholder="每行一个，或用逗号隔开\n例如：a/gemini-3.8-flash" required></textarea>
                        </label>
                    </div>
                    <label class="qsh-check-row">
                        <input id="qsh-switch-after-save" type="checkbox" checked>
                        <span>保存后立即切到第一个模型</span>
                    </label>
                    <div class="qsh-form-actions">
                        <button id="qsh-cancel-add" type="button" class="menu_button">取消</button>
                        <button id="qsh-save-station" type="submit" class="menu_button qsh-primary-button">
                            <i class="fa-solid fa-floppy-disk"></i><span>保存并加入</span>
                        </button>
                    </div>
                </form>

                <form id="qsh-edit-form" class="qsh-add-form qsh-hidden">
                    <input id="qsh-edit-station-id" type="hidden">
                    <div class="qsh-form-title">
                        <strong>编辑站子</strong>
                        <span>API Key 留空表示继续使用原来的密钥。</span>
                    </div>
                    <div class="qsh-form-grid">
                        <label>
                            <span>站子名称</span>
                            <input id="qsh-edit-station-name" class="text_pole" type="text" required>
                        </label>
                        <label>
                            <span>API 地址</span>
                            <input id="qsh-edit-endpoint" class="text_pole" type="url" required>
                        </label>
                        <label class="qsh-wide-field">
                            <span>模型广场链接（可选）</span>
                            <input id="qsh-edit-model-plaza-url" class="text_pole" type="url" placeholder="https://example.com/pricing">
                        </label>
                        <label class="qsh-wide-field">
                            <span>更换 API Key（可选）</span>
                            <input id="qsh-edit-api-key" class="text_pole" type="password" autocomplete="new-password" placeholder="不更换就留空">
                        </label>
                    </div>
                    <div class="qsh-form-actions">
                        <button id="qsh-cancel-edit" type="button" class="menu_button">取消</button>
                        <button id="qsh-save-edit" type="submit" class="menu_button qsh-primary-button">
                            <i class="fa-solid fa-floppy-disk"></i><span>保存修改</span>
                        </button>
                    </div>
                </form>

                <div id="qsh-status" class="qsh-status" aria-live="polite"></div>
                <main id="qsh-station-list" class="qsh-station-list"></main>
                <div id="qsh-search-empty" class="qsh-empty qsh-hidden">
                    <i class="fa-solid fa-magnifying-glass"></i><strong>没搜到</strong><span>换个站子名或模型名试试。</span>
                </div>
            </section>
        </div>`;
}

function settingsMarkup() {
    return `
        <div id="qsh-settings" class="qsh-settings inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>梨枢 · Lishu Model Hub</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p class="notes">复用酒馆的 Connection Profiles，一键切换站子和模型。</p>
                <label class="checkbox_label">
                    <input id="qsh-show-launcher-setting" type="checkbox">
                    <span>在输入框旁显示快捷入口</span>
                </label>
                <button id="qsh-open-from-settings" type="button" class="menu_button" popovertarget="qsh-overlay" popovertargetaction="show">
                    <i class="fa-solid fa-layer-group"></i><span>打开梨枢</span>
                </button>
            </div>
        </div>`;
}

function injectUi() {
    if (!document.getElementById('qsh-overlay')) {
        document.body.insertAdjacentHTML('beforeend', modalMarkup());
    }

    if (!document.getElementById('qsh-launcher')) {
        const launcher = document.createElement('button');
        launcher.type = 'button';
        launcher.id = 'qsh-launcher';
        launcher.className = 'fa-solid fa-layer-group interactable';
        launcher.setAttribute('popovertarget', 'qsh-overlay');
        launcher.setAttribute('popovertargetaction', 'show');
        launcher.title = '打开梨枢';
        const label = document.createElement('span');
        label.id = 'qsh-launcher-label';
        label.className = 'qsh-launcher-label qsh-hidden';
        launcher.append(label);
        const leftSendForm = document.getElementById('leftSendForm');
        leftSendForm?.append(launcher);
    }

    if (!document.getElementById('qsh-menu-entry')) {
        const entry = document.createElement('button');
        entry.type = 'button';
        entry.id = 'qsh-menu-entry';
        entry.setAttribute('popovertarget', 'qsh-overlay');
        entry.setAttribute('popovertargetaction', 'show');
        entry.className = 'list-group-item flex-container flexGap5';
        entry.innerHTML = '<div class="fa-solid fa-layer-group extensionsMenuExtensionButton"></div><span>梨枢</span>';
        document.getElementById('extensionsMenu')?.prepend(entry);
    }

    if (!document.getElementById('qsh-settings')) {
        const settingsContainer = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        settingsContainer?.insertAdjacentHTML('beforeend', settingsMarkup());
    }
}

function observeDeferredUi() {
    uiObserver?.disconnect();
    uiObserver = new MutationObserver(() => {
        const needsMenuEntry = document.getElementById('extensionsMenu') && !document.getElementById('qsh-menu-entry');
        const needsLauncher = document.getElementById('leftSendForm') && !document.getElementById('qsh-launcher');
        const settingsContainer = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        const needsSettings = settingsContainer && !document.getElementById('qsh-settings');
        if (!needsMenuEntry && !needsLauncher && !needsSettings) return;

        injectUi();
        updateLauncherVisibility();
        renderCurrentProfile(getConnectionManager());
    });
    uiObserver.observe(document.body, { childList: true, subtree: true });
}

function updateLauncherVisibility() {
    document.getElementById('qsh-launcher')?.classList.toggle('qsh-hidden', !settings.showLauncher);
    const checkbox = document.getElementById('qsh-show-launcher-setting');
    if (checkbox instanceof HTMLInputElement) checkbox.checked = Boolean(settings.showLauncher);
}

function bindUi() {
    document.getElementById('qsh-show-add')?.addEventListener('click', () => showAddForm(true));
    document.getElementById('qsh-cancel-add')?.addEventListener('click', () => showAddForm(false));
    document.getElementById('qsh-add-form')?.addEventListener('submit', addStation);
    document.getElementById('qsh-cancel-edit')?.addEventListener('click', hideEditStationForm);
    document.getElementById('qsh-edit-form')?.addEventListener('submit', editStation);
    document.getElementById('qsh-search')?.addEventListener('input', filterCards);

    document.getElementById('qsh-close')?.addEventListener('click', event => {
        event.preventDefault();
        closeHub();
    });

    const overlay = document.getElementById('qsh-overlay');
    overlay?.addEventListener('toggle', event => {
        const isOpen = event.newState === 'open';
        document.body.classList.toggle('qsh-modal-open', isOpen);
        if (isOpen) {
            render();
            setTimeout(() => document.getElementById('qsh-search')?.focus(), 0);
        } else {
            showAddForm(false);
            hideEditStationForm();
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && overlay?.matches(':popover-open')) {
            closeHub();
        }
    });

    document.getElementById('qsh-show-launcher-setting')?.addEventListener('change', event => {
        settings.showLauncher = Boolean(event.target?.checked);
        getContext()?.saveSettingsDebounced?.();
        updateLauncherVisibility();
    });
}

function bindSillyTavernEvents() {
    const context = getContext();
    if (!context) return;

    const renderEvents = [
        context.eventTypes.CONNECTION_PROFILE_LOADED,
        context.eventTypes.CONNECTION_PROFILE_CREATED,
        context.eventTypes.CONNECTION_PROFILE_UPDATED,
        context.eventTypes.CONNECTION_PROFILE_DELETED,
        context.eventTypes.ONLINE_STATUS_CHANGED,
    ].filter(Boolean);
    for (const eventType of renderEvents) {
        context.eventSource.on(eventType, render);
    }

    if (context.eventTypes.GENERATION_STARTED) {
        context.eventSource.on(context.eventTypes.GENERATION_STARTED, recordGenerationStarted);
    }
    const usageEvents = [
        context.eventTypes.MESSAGE_RECEIVED,
        context.eventTypes.MESSAGE_UPDATED,
    ].filter(Boolean);
    for (const eventType of new Set(usageEvents)) {
        context.eventSource.on(eventType, recordMessageUsage);
    }
}

function initializeSettings() {
    const context = getContext();
    if (!context) throw new Error('SillyTavern context is unavailable');

    context.extensionSettings[MODULE_ID] ??= structuredClone(DEFAULT_SETTINGS);
    settings = context.extensionSettings[MODULE_ID];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) settings[key] = structuredClone(value);
    }

    const manager = getConnectionManager();
    for (const profile of manager?.profiles || []) {
        const stationId = stationIdForProfile(profile);
        const meta = getStationMeta(stationId);
        meta.name ??= inferStationName(profile, normalizeEndpoint(profile['api-url']));
        meta.modelPlazaUrl ??= profile.qingliModelPlazaUrl || '';
    }
}

async function waitForCoreUi(timeoutMs = 15_000) {
    const started = Date.now();
    while (!getContext() || !document.body || !document.getElementById('leftSendForm')) {
        if (Date.now() - started >= timeoutMs) return false;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return true;
}

export async function init() {
    if (initialized) return;
    try {
        const coreReady = await waitForCoreUi();
        if (!coreReady) throw new Error('SillyTavern core UI is unavailable');
        initializeSettings();
        injectUi();
        bindUi();
        bindSillyTavernEvents();
        observeDeferredUi();
        updateLauncherVisibility();
        render();
        initialized = true;
        console.info('[Lishu Model Hub] 已加载');
    } catch (error) {
        console.error('[Lishu Model Hub] 启动失败', error);
        notify('error', error?.message || '梨枢启动失败。');
    }
}

export const __test = {
    normalizeEndpoint,
    parseModels,
    endpointKey,
    groupProfiles,
    uniqueProfileName,
    escapeAttribute,
    formatTokens,
    usageFromObject,
    shortModelName,
};

// SillyTavern imports third-party extension modules but does not call exported
// functions automatically. Start the extension as soon as this module loads.
// The hub itself no longer waits for an API connection to exist.
void init();
