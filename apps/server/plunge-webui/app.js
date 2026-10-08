const $ = (s) => document.querySelector(s);
const el = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
let reconnectTimer,
  reconnectDelay = 1000,
  disconnected = false;
let token = "",
  page = "overview",
  dirty = false,
  loadGeneration = 0;
const titles = {
  overview: "运行概况",
  models: "模型与路由",
  memory: "长期记忆",
  participation: "QQ 参与策略",
  prompts: "Prompt Inspector",
  diagnostics: "插件与诊断"
};
const caps = ["chat", "reasoning", "vision", "embedding", "stt", "tts", "proactive"];
const capNames = {
  chat: "Chat",
  reasoning: "Cognition / Reasoning",
  vision: "Vision",
  embedding: "Embedding",
  stt: "STT",
  tts: "TTS",
  proactive: "主动决策（Core）"
};
const pretty = (v) => JSON.stringify(v, null, 2);
function feedback(message, error = false) {
  $("#feedback").textContent = message;
  $("#feedback").className = error ? "error" : "";
}
async function api(path, method = "GET", body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
  } catch {
    disconnected = true;
    scheduleReconnect();
    throw new Error(
      method === "GET"
        ? "连接中断，正在自动重连。"
        : "连接中断，本次写入结果未知。恢复后先读取状态；不会自动重提交。"
    );
  }
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      `${response.status} · ${result.message ?? result.error ?? "操作失败"}${result.details ? "\n" + pretty(result.details) : ""}`
    );
  return result;
}
function panel(title, note) {
  const p = el("section", undefined, "panel");
  if (title) p.append(el("h2", title));
  if (note) p.append(el("p", note));
  return p;
}
function dump(value) {
  return el("pre", typeof value === "string" ? value : pretty(value));
}
function details(title, value) {
  const d = el("details");
  d.append(el("summary", title), dump(value));
  return d;
}
function kv(values) {
  const d = el("div", undefined, "kv");
  for (const [k, v] of Object.entries(values))
    d.append(el("b", k), el("span", typeof v === "object" ? pretty(v) : String(v ?? "—")));
  return d;
}
function field(container, label, value, type = "text") {
  const l = el("label", label),
    i = el(type === "textarea" ? "textarea" : "input");
  if (type !== "textarea") i.type = type;
  if (type === "checkbox") i.checked = !!value;
  else i.value = value ?? "";
  l.append(i);
  container.append(l);
  i.addEventListener("input", () => {
    dirty = true;
  });
  return i;
}
function select(container, label, value, values) {
  const l = el("label", label),
    s = el("select");
  for (const v of values) {
    const o = el("option", v);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  l.append(s);
  container.append(l);
  s.addEventListener("change", () => {
    dirty = true;
  });
  return s;
}
function button(label, action, cls) {
  const b = el("button", label, cls);
  b.type = "button";
  b.onclick = async () => {
    b.disabled = true;
    try {
      await action();
    } catch (e) {
      feedback(e.message, true);
    } finally {
      b.disabled = false;
    }
  };
  return b;
}
function table(headers, rows) {
  const t = el("table"),
    thead = el("thead"),
    tr = el("tr");
  headers.forEach((h) => tr.append(el("th", h)));
  thead.append(tr);
  t.append(thead);
  const body = el("tbody");
  rows.forEach((row) => {
    const tr = el("tr");
    row.forEach((v) => tr.append(el("td", String(v ?? "—"))));
    body.append(tr);
  });
  t.append(body);
  return t;
}
async function load() {
  if (!token) return;
  const generation = ++loadGeneration;
  $("#connection").textContent = "读取中";
  try {
    const node = await renderers[page]();
    if (generation !== loadGeneration) return;
    $("#content").replaceChildren(node);
    $("#content").hidden = false;
    $("#login").hidden = true;
    disconnected = false;
    reconnectDelay = 1000;
    scheduleReconnect(5000);
    $("#connection").textContent = "已解锁 · 本机";
    $("#connection").className = "pill good";
    dirty = false;
  } catch (e) {
    feedback(e.message, true);
    $("#connection").textContent = "读取失败";
  }
}
async function overview() {
  const s = await api("/plunge/api/status"),
    root = el("div"),
    grid = el("div", undefined, "grid");
  const ready = s.plunge.connection?.ready;
  for (const [name, value, note] of [
    ["Alice", s.character.definition.name, s.character.instanceId],
    [
      "QQ / SnowLuma",
      ready ? "已连接" : "未就绪",
      `队列 ${s.plunge.connection?.queued ?? 0} · 等待 ACK ${s.plunge.connection?.pending ?? 0}`
    ],
    ["记忆", s.memoryRepository, `写入管道 ${s.memoryIngestion.status}`]
  ]) {
    const p = panel(name);
    p.append(el("div", value, "metric"), el("span", note, "muted"));
    grid.append(p);
  }
  root.append(grid);
  const persona = panel("Character 人格", "Authored 内容只读。修改权限由 Character / P8 决定。");
  persona.append(
    kv({
      定义版本: s.character.definition.revision,
      身份: s.character.definition.authoredInvariants
        .filter((i) => i.target === "identity")
        .map((i) => i.statement)
        .join("\n")
    }),
    details(
      "当前人格",
      s.character.definition.authoredInvariants
        .filter((i) => i.target === "persona")
        .map((i) => i.statement)
        .join("")
    ),
    details("RESPONSE_REQUIREMENTS", s.character.definition.responseRequirements)
  );
  root.append(persona);
  const model = panel("实际绑定的模型");
  model.append(
    table(
      ["能力", "Provider / Model", "就绪 / 最近观察"],
      Object.entries(s.providers.providers).map(([cap, p]) => [
        capNames[cap] ?? cap,
        `${p.provider} / ${p.model ?? "—"}`,
        `${p.readiness ?? "—"} / ${p.observed ?? "unknown"}`
      ])
    )
  );
  root.append(model);
  const errorPanel = panel("最近错误");
  const errors = s.events.filter((e) => /error|failed/i.test(e.type));
  if (errors.length)
    errors.slice(0, 5).forEach((e) => errorPanel.append(details(e.type, e.payload)));
  else errorPanel.append(el("p", "本进程暂无错误事件。"));
  root.append(errorPanel);
  const activity = panel("最近活跃会话", "本进程已观测的 QQ 会话；重启后会重新积累。");
  const channels = [...new Set(s.plunge.events.map((e) => e.channel).filter(Boolean))];
  activity.append(
    channels.length
      ? table(
          ["会话", "最近结果"],
          channels.map((c) => [
            c,
            s.plunge.events.find((e) => e.channel === c)?.outcome ??
              s.plunge.events.find((e) => e.channel === c)?.kind
          ])
        )
      : el("p", "暂无会话事件")
  );
  root.append(activity);
  return root;
}
async function models() {
  const saved = await api("/product/configuration"),
    config = structuredClone(saved.configuration),
    root = el("div");
  const status = panel(
    "配置状态",
    "保存并应用复用现有 Provider Registry。Embedding 空间变化需要重启 Alice；密钥不回显，留空保留已有密钥。"
  );
  status.append(el("span", saved.applyState, "pill"), details("路由实际状态", saved.routes));
  root.append(status);
  const providerFields = [];
  for (const p of config.providers) {
    const card = panel(p.displayName + " · Provider"),
      grid = el("div", undefined, "grid two");
    const name = field(grid, "显示名称", p.displayName),
      url = field(grid, "Endpoint", p.baseUrl),
      adapter = select(grid, "Adapter", p.adapter, [
        "openai-compatible",
        "local-stt",
        "dashscope",
        "xai-tts",
        "dots-tts",
        "gpt-sovits"
      ]),
      key = field(
        grid,
        p.hasApiKey ? "新密钥（已配置；空白保留）" : "密钥（尚未配置）",
        "",
        "password"
      );
    key.autocomplete = "new-password";
    card.append(
      grid,
      button("检查 Endpoint", async () => {
        const r = await api(`/product/providers/${encodeURIComponent(p.id)}/test`, "POST", {});
        feedback(r.message);
      })
    );
    root.append(card);
    providerFields.push({ p, name, url, adapter, key });
    delete p.hasApiKey;
  }
  const modelFields = [];
  for (const m of config.models) {
    const card = panel(m.displayName + " · Model"),
      grid = el("div", undefined, "grid");
    const name = field(grid, "显示名称", m.displayName),
      provider = select(
        grid,
        "Provider",
        m.providerId,
        config.providers.map((p) => p.id)
      ),
      id = field(grid, "模型 ID", m.modelId),
      temp = field(grid, "Temperature", m.temperature, "number"),
      ctx = field(grid, "Context window（空白使用默认）", m.contextWindow, "number");
    temp.step = ".05";
    temp.min = "0";
    temp.max = "2";
    const dims = field(grid, "Embedding dimensions", m.dimensions ?? "", "number"),
      voice = field(grid, "TTS voice", m.voice ?? "");
    const checks = el("div", undefined, "checkline"),
      capFields = {};
    for (const c of caps) capFields[c] = field(checks, c, m.capabilities.includes(c), "checkbox");
    const enabled = field(checks, "启用", m.enabled, "checkbox");
    card.append(grid, checks);
    root.append(card);
    modelFields.push({ m, name, provider, id, temp, ctx, dims, voice, capFields, enabled });
  }
  const routing = panel(
    "能力路由与 fallback",
    "按顺序填写模型管理 ID，以逗号分隔。前面的模型优先；留空表示未配置。"
  );
  const routes = {};
  for (const c of caps) routes[c] = field(routing, capNames[c], config.routes[c].join(", "));
  root.append(routing);
  const advanced = panel("新增 Provider 或 Model");
  advanced.append(el("p", "新增项沿用同一配置协议。表单保存后重新读取，可继续通过上方字段编辑。"));
  const json = field(advanced, "完整配置 JSON（密钥省略时保留）", pretty(config), "textarea");
  json.rows = 12;
  advanced.append(
    button(
      "保存 JSON 并应用",
      async () => {
        const candidate = JSON.parse(json.value);
        candidate.providers.forEach((p) => delete p.hasApiKey);
        await save(candidate);
      },
      "primary"
    )
  );
  root.append(advanced);
  async function save(candidate) {
    const result = await api("/product/configuration", "PUT", {
      revision: saved.revision,
      configuration: candidate
    });
    feedback(result.applyState === "ACTIVE" ? "已保存，已生效" : `已保存 · ${result.applyState}`);
    dirty = false;
    await load();
  }
  const tools = el("div", undefined, "toolbar");
  tools.append(
    button(
      "保存表单并应用",
      async () => {
        providerFields.forEach(({ p, name, url, adapter, key }) => {
          p.displayName = name.value;
          p.baseUrl = url.value;
          p.adapter = adapter.value;
          if (key.value) p.apiKey = key.value;
        });
        modelFields.forEach(
          ({ m, name, provider, id, temp, ctx, dims, voice, capFields, enabled }) => {
            m.displayName = name.value;
            m.providerId = provider.value;
            m.modelId = id.value;
            m.temperature = Number(temp.value);
            m.contextWindow = ctx.value ? Number(ctx.value) : null;
            m.enabled = enabled.checked;
            m.capabilities = caps.filter((c) => capFields[c].checked);
            if (dims.value) m.dimensions = Number(dims.value);
            else delete m.dimensions;
            if (voice.value) m.voice = voice.value;
            else delete m.voice;
          }
        );
        caps.forEach(
          (c) =>
            (config.routes[c] = routes[c].value
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean))
        );
        await save(config);
      },
      "primary"
    )
  );
  root.prepend(tools);
  return root;
}
async function participation() {
  const s = await api("/plunge/api/participation"),
    root = el("div"),
    p = panel(
      "参与机会",
      "这些开关只决定是否进入 Character 评估。评估后仍可 SILENCE。环境中的主动调度不等于主动向 QQ 发送消息。"
    );
  p.append(el("span", s.restartRequired ? "允许列表待重启" : "配置已生效", "pill"));
  const checks = el("div", undefined, "checkline"),
    fields = {},
    policy = s.saved.participation;
  for (const [k, label] of Object.entries({
    private: "私聊候选",
    mention: "@ Alice",
    reply: "回复 / 引用 Alice",
    alias: "名称触发",
    ambientAttention: "普通群聊 Attention 预筛",
    quoteReply: "发送时引用原消息"
  }))
    fields[k] = field(checks, label, policy[k], "checkbox");
  p.append(checks);
  if (!s.attentionConfigured)
    p.append(el("p", "当前未配置 Attention 服务。普通群聊预筛开关不会启用一个不存在的模型。"));
  const grid = el("div", undefined, "grid");
  for (const [k, label] of Object.entries({
    continuationMs: "续聊窗口（毫秒；0 关闭）",
    groupCooldownMs: "群聊候选冷却（毫秒；0–120000）",
    privateCooldownMs: "私聊候选冷却（毫秒；0–120000）"
  }))
    fields[k] = field(grid, label, policy[k], "number");
  p.append(grid);
  const groups = field(
      p,
      "允许参与的群（每行一个 QQ 群号）",
      s.saved.groups.join("\n"),
      "textarea"
    ),
    peers = field(
      p,
      "允许参与的私聊（每行一个 QQ 号）",
      s.saved.privatePeers.join("\n"),
      "textarea"
    );
  p.append(
    button(
      "保存参与策略",
      async () => {
        const participation = Object.fromEntries(
          Object.entries(fields).map(([k, i]) => [
            k,
            i.type === "checkbox" ? i.checked : Number(i.value)
          ])
        );
        const list = (i) => i.value.split(/\s+/).filter(Boolean);
        const r = await api("/plunge/api/participation", "PUT", {
          revision: s.revision,
          groups: list(groups),
          privatePeers: list(peers),
          participation
        });
        feedback(
          r.restartRequired ? "策略已生效；群与私聊允许列表已保存，待重启" : "已保存，已生效"
        );
        dirty = false;
        await load();
      },
      "primary"
    ),
    details("当前实际生效配置", s.active)
  );
  root.append(p);
  return root;
}
async function memory() {
  const root = el("div"),
    p = panel(
      "Alice 长期记忆",
      "内容来自 Alice 独立的 Memory Repository。检索和证据只读；语义纠正经现有 Journal / A9 / P8 路径提交，不直接改写记忆表。"
    ),
    bar = el("div", undefined, "toolbar");
  const query = el("input");
  query.placeholder = "检索记忆内容";
  query.setAttribute("aria-label", "记忆检索");
  const results = el("div");
  async function search() {
    const r = query.value.trim()
      ? await api("/memory/search", "POST", { q: query.value.trim(), limit: 30 })
      : await api("/memory/recent?limit=30");
    results.replaceChildren();
    if (!r.memories?.length) results.append(el("p", "没有匹配的记忆。"));
    for (const m of r.memories ?? []) {
      const c = el("article", undefined, "memory");
      c.append(
        el("h3", m.summary || m.type || m.id),
        el("p", m.content),
        el(
          "span",
          `${m.source ?? "—"} · ${m.createdAt ?? "—"} · 人物 ${m.subjectUserId ?? "未标注"}`,
          "tag"
        ),
        details("来源、时间、隔离与证据元数据", m)
      );
      results.append(c);
    }
  }
  bar.append(query, button("检索 / 刷新", search));
  p.append(bar, results);
  root.append(p);
  await search();
  const status = await api("/plunge/api/status"),
    people = [...new Map(status.plunge.people.map((p) => [p.id, p])).values()];
  const correction = panel(
      "受治理的语义纠正",
      "已有稳定解释目标 relationship.current。通过现有 Journal / A9 / P8 提交关系修正或撤回；不会改写 Memory 原始证据。"
    ),
    form = el("div");
  if (people.length) {
    const person = select(
      correction,
      "相关人物",
      people[0].id,
      people.map((p) => p.id)
    );
    people.forEach((p, i) => (person.options[i].textContent = p.name + " · " + p.id));
    let current;
    async function correctionForm() {
      current = await api(
        "/plunge/api/memory/corrections?personId=" + encodeURIComponent(person.value)
      );
      form.replaceChildren();
      const action = select(form, "操作", "REVISE", ["REVISE", "RETRACT"]),
        meaning = field(form, "明确纠正后的关系含义", "", "textarea"),
        records = current.loaded.corrections ?? [];
      const prior = select(form, "明确取代已有纠正（无旧记录可留空）", "", [
        "",
        ...records.map((r) => r.correctionReference)
      ]);
      const superseded = field(
        form,
        "明确取代的 evidence references（每行一个；可留空）",
        "",
        "textarea"
      );
      let record;
      form.append(
        button(
          "提交语义纠正",
          async () => {
            // Retain the command identity/body after failure so retry cannot create a second command.
            record ??= {
              ...current.template,
              action: action.value,
              ...(action.value === "REVISE" ? { replacementMeaning: meaning.value } : {}),
              supersededEvidenceReferences: superseded.value.split(/\s+/).filter(Boolean),
              ...(prior.value ? { supersedesCorrectionReference: prior.value } : {})
            };
            if (record.action === "RETRACT") delete record.replacementMeaning;
            const r = await api("/p8/corrections", "POST", record);
            feedback(`${r.status} · Journal ${r.controlReceiptRef?.eventId ?? ""}`);
            dirty = false;
            await correctionForm();
            await search();
          },
          "primary"
        ),
        details("已存储语义纠正 / 受治理状态", current.loaded)
      );
    }
    person.onchange = () => correctionForm().catch((e) => feedback(e.message, true));
    await correctionForm();
  } else form.append(el("p", "没有已授权的 Product Person 绑定，不能创建人物关系修正。"));
  correction.append(form);
  const advanced = el("details");
  advanced.append(el("summary", "高级：现有 P8 Correction Record"));
  const record = field(advanced, "P8 Correction Record JSON", "", "textarea");
  record.rows = 8;
  advanced.append(
    button(
      "提交现有记录",
      async () => {
        const r = await api("/p8/corrections", "POST", JSON.parse(record.value));
        feedback(`${r.status} · Journal ${r.controlReceiptRef?.eventId ?? ""}`);
        dirty = false;
        await search();
      },
      "primary"
    )
  );
  correction.append(advanced);
  root.append(correction);
  const pipeline = await api("/plunge/api/memory/pipeline");
  const pipe = panel(
    "Finalized / Dream 管道",
    "现有管道诊断与待完成 Finalized 记录。已检索记忆中的来源元数据保留 Finalized、Dream 与 evidence 链接。"
  );
  pipe.append(
    details("管道诊断", pipeline.diagnostics),
    details("待完成 Finalized", pipeline.pendingFinalized),
    details("到期 Dream jobs", pipeline.dueDream)
  );
  root.append(pipe);
  return root;
}
async function prompts() {
  const root = el("div"),
    note = panel(
      "实际 ChatModel 输入",
      "捕获真实 generateReply / streamReply 调用。按真实 offset 切片，保留线性原文及完整 ChatInput。包括候选判断、重试、Cognition 后续和最终生成请求；无请求时不会编造预览。最多保留最近 12 次调用，仅驻留内存。"
    );
  root.append(note);
  const r = await api("/plunge/api/prompts"),
    layout = el("div", undefined, "prompt-layout"),
    list = el("div", undefined, "requests"),
    view = panel("选择请求");
  layout.append(list, view);
  root.append(layout);
  if (!r.requests.length)
    view.append(el("p", "暂无捕获。Alice 收到下一条已授权 QQ 候选后，这里将显示实际模型输入。"));
  async function show(entry, b) {
    const req = await api("/plunge/api/prompts/" + entry.id);
    list.querySelectorAll("button").forEach((e) => e.classList.remove("active"));
    b.classList.add("active");
    view.replaceChildren(
      el("h2", req.mode === "streamReply" ? "最终流式生成请求" : "候选 / 授权 / 生成请求"),
      el("p", `${req.at} · ${req.outcome} · ${req.model ?? req.provider}`)
    );
    if (req.decision) view.append(kv({ "模型判断（只读）": req.decision }));
    if (req.errorCode)
      view.append(el("p", `调用失败：${req.errorCode}。失败不会自动重放 QQ 消息。`));
    const toolbar = el("div", undefined, "toolbar"),
      body = el("div");
    function parts() {
      body.replaceChildren();
      for (const part of req.parts) {
        const c = el("div", undefined, "part"),
          h = el("h3", part.key);
        h.append(el("span", part.authority, "pill"));
        c.append(h, dump(part.text));
        body.append(c);
      }
      if (!req.parts.length) body.append(el("p", "本次输入未声明组成位置，请查看线性原文。"));
      const absent = [
        "IDENTITY",
        "PERSONA",
        "RESPONSE_REQUIREMENTS",
        "RELATIONSHIP_CONTEXT",
        "MEMORY_EVIDENCE",
        "RECENT_CONVERSATION",
        "CURRENT_SITUATION",
        "COGNITION_RESULT",
        "VISUAL_OBSERVATION"
      ].filter((k) => !req.parts.some((p) => p.key === k));
      if (absent.length)
        body.append(
          el(
            "p",
            "本次未独立出现：" +
              absent.join("、") +
              "。原生 QQ 的近期消息位于 CURRENT_SITUATION；Cognition / Vision 只在实际执行后出现。"
          )
        );
      body.append(details("协议及未分类文本（完整输入）", req.input));
    }
    function linear() {
      body.replaceChildren();
      req.input.messages.forEach((m, i) => {
        body.append(el("h3", `${i + 1} · ${m.role}`), dump(m.content));
      });
    }
    toolbar.append(
      button("按组成查看", parts),
      button("线性原文", linear),
      button("完整 ChatInput", () => {
        body.replaceChildren(dump(req.input));
      })
    );
    view.append(toolbar, body);
    parts();
  }
  for (const entry of r.requests) {
    const b = button(
      `${entry.mode === "streamReply" ? "最终生成" : "非流式调用"} · ${entry.outcome}${entry.decision?.authorization ? " · " + entry.decision.authorization : entry.decision?.disposition ? " · " + entry.decision.disposition : ""}`,
      () => show(entry, b)
    );
    b.append(
      el(
        "small",
        `${new Date(entry.at).toLocaleTimeString()} · ${entry.characters} 字符 · ${entry.model ?? entry.provider}`
      )
    );
    list.append(b);
  }
  if (r.requests[0]) await show(r.requests[0], list.firstChild);
  return root;
}
async function diagnostics() {
  const s = await api("/plunge/api/status"),
    apps = await api("/plunge/api/apps"),
    root = el("div"),
    p = panel(
      "QQ / SnowLuma",
      "NATIVE_ACK 表示外部服务接受；UNKNOWN 不代表发送失败，也不会自动重发。SILENCE 保持零发送。"
    );
  p.append(
    button("打开 QQ", async () => {
      await api("/plunge/api/apps/qq/open", "POST", {});
      feedback("已请求打开 QQ；客户端已运行时将由 QQ 唤起现有窗口。");
    }),
    button("打开 SnowLuma", async () => {
      const popup = window.open("about:blank", "_blank");
      if (popup) popup.opener = null;
      try {
        const result = await api("/plunge/api/apps/snowluma/open", "POST", {});
        if (popup) popup.location.href = result.url;
        else feedback("SnowLuma 已就绪，请刷新后点击控制台链接。");
        if (popup)
          feedback(
            result.started ? "SnowLuma 已启动并打开控制台。" : "已打开现有 SnowLuma 控制台。"
          );
      } catch (error) {
        popup?.close();
        throw error;
      }
    }),
    button("重新连接 QQ", async () => {
      await api("/plunge/api/reconnect", "POST", {});
      feedback("QQ 正在重连；不会重发历史消息或 UNKNOWN 发送。");
    }),
    kv(s.plunge.connection ?? {}),
    table(
      ["时间", "事件", "结果 / 原因", "会话"],
      s.plunge.events.map((e) => [
        new Date(e.at).toLocaleTimeString(),
        e.kind,
        e.outcome ?? e.reason ?? e.failureCode,
        e.channel
      ])
    )
  );
  p.append(
    el(
      "p",
      `QQ 启动路径：${apps.qq.configured ? "已配置" : "未找到；启动脚本可用 --qq 指定"} · SnowLuma：${apps.snowluma.configured ? "已配置" : "未找到；可用 --snowluma 指定"}`
    )
  );
  if (apps.snowluma.url) {
    const link = el("a", "打开现有 SnowLuma 控制台");
    link.href = apps.snowluma.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    p.append(link);
  }
  root.append(p);
  const e = panel(
    "Runtime 事件 · 最近消息 / Vision / 错误",
    "仅展示当前 Alice 进程的有界事件投影；需要管理令牌。"
  );
  for (const event of s.events)
    e.append(details(`${event.timestamp ?? ""} · ${event.type ?? "事件"}`, event));
  root.append(e);
  return root;
}
const renderers = { overview, models, memory, participation, prompts, diagnostics };
$("#unlock").onsubmit = async (e) => {
  e.preventDefault();
  token = $("#token").value.trim();
  $("#token").value = "";
  await load();
};
$("#refresh").onclick = () => {
  if (dirty) {
    feedback("存在未保存修改。保存后刷新，或切换页面放弃修改。", true);
    return;
  }
  load();
};
$("#logout").onclick = () => {
  clearTimeout(reconnectTimer);
  token = "";
  ++loadGeneration;
  $("#content").replaceChildren();
  $("#content").hidden = true;
  $("#login").hidden = false;
  $("#connection").textContent = "已锁定";
  feedback("");
};
for (const b of document.querySelectorAll("[data-page]"))
  b.onclick = () => {
    page = b.dataset.page;
    dirty = false;
    $("#title").textContent = titles[page];
    document.querySelectorAll("[data-page]").forEach((e) => e.classList.toggle("active", e === b));
    feedback("");
    load();
  };
$("[data-page=overview]").classList.add("active");
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

function scheduleReconnect(delay = reconnectDelay) {
  clearTimeout(reconnectTimer);
  if (!token) return;
  reconnectTimer = setTimeout(async () => {
    if (!token) return;
    try {
      const r = await fetch("/plunge/api/status", {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (r.status === 401) {
        $("#connection").textContent = "令牌失效 · 请重新解锁";
        return;
      }
      if (!r.ok) throw Error("status unavailable");
      await r.json();
      const recovered = disconnected;
      disconnected = false;
      reconnectDelay = 1000;
      $("#connection").textContent = "已解锁 · 本机";
      $("#connection").className = "pill good";
      if (recovered) feedback("连接已恢复。只读状态已重新连接，未自动重提交任何写操作。");
      if (
        !dirty &&
        (page === "overview" || (recovered && ["prompts", "diagnostics"].includes(page)))
      )
        await load();
      scheduleReconnect(5000);
    } catch {
      disconnected = true;
      $("#connection").textContent = "连接中断 · 自动重连";
      $("#connection").className = "pill warn";
      reconnectDelay = Math.min(30000, reconnectDelay * 2);
      scheduleReconnect();
    }
  }, delay);
}
window.addEventListener("online", () => scheduleReconnect(0));
