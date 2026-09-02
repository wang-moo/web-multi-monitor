import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

const DEFAULT_URL = "";
const PAGE_SIZE = 4;
const IS_TAURI = "__TAURI_INTERNALS__" in window;

function Icon({ name }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    layers: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 2h8M8 22h8" /></>,
    expand: <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />,
    collapse: <path d="M8 8H3V3M16 8h5V3M8 16H3v5M16 16h5v5" />,
    close: <path d="m7 7 10 10M17 7 7 17" />,
    refresh: <><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5" /><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" /></>,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />,
    left: <path d="m15 18-6-6 6-6" />,
    right: <path d="m9 18 6-6-6-6" />,
    link: <><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></>,
    rotate: <><path d="M20 7v5h-5" /><path d="M18.4 16A8 8 0 1 1 20 12" /></>,
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function instanceNumber(label) {
  return Number(label.replace("instance-", ""));
}

function App() {
  const [targetUrl, setTargetUrl] = useState(DEFAULT_URL);
  const [instances, setInstances] = useState([]);
  const [page, setPage] = useState(0);
  const [maximized, setMaximized] = useState(null);
  const [rotations, setRotations] = useState({});
  const [speeds, setSpeeds] = useState({});
  const [speedDrafts, setSpeedDrafts] = useState({});
  const [globalSpeed, setGlobalSpeed] = useState(1);
  const [globalSpeedDraft, setGlobalSpeedDraft] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hosts = useRef(new Map());

  const loadInstances = useCallback(async () => {
    if (!IS_TAURI) return [];
    const labels = await invoke("list_instances");
    labels.sort((a, b) => instanceNumber(a) - instanceNumber(b));
    setInstances(labels);
    return labels;
  }, []);

  useEffect(() => {
    loadInstances().catch((reason) => setError(String(reason)));
  }, [loadInstances]);

  const pageCount = Math.max(1, Math.ceil(instances.length / PAGE_SIZE));
  useEffect(() => setPage((current) => Math.min(current, pageCount - 1)), [pageCount]);
  useEffect(() => {
    if (maximized && !instances.includes(maximized)) setMaximized(null);
  }, [instances, maximized]);

  const pageItems = useMemo(() => {
    if (maximized) return instances.includes(maximized) ? [maximized] : [];
    return instances.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  }, [instances, maximized, page]);

  const syncLayout = useCallback(() => {
    if (!IS_TAURI) return;
    const visible = new Set(pageItems);
    for (const label of instances) {
      const host = hosts.current.get(label);
      if (!visible.has(label) || !host) {
        invoke("set_instance_bounds", { label, x: 0, y: 0, width: 1, height: 1, visible: false, rotation: rotations[label] ?? 0 }).catch(setError);
        continue;
      }
      const rect = host.getBoundingClientRect();
      invoke("set_instance_bounds", {
        label,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
        visible: true,
        rotation: rotations[label] ?? 0,
      }).catch(setError);
    }
  }, [instances, pageItems, rotations]);

  useLayoutEffect(() => {
    let frame = window.requestAnimationFrame(syncLayout);
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(syncLayout);
    });
    const grid = document.querySelector(".monitor-grid");
    if (grid) observer.observe(grid);
    window.addEventListener("resize", syncLayout);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", syncLayout);
    };
  }, [syncLayout]);

  async function createOne(event) {
    event?.preventDefault();
    let parsed;
    try {
      parsed = new URL(targetUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("只允许 HTTP/HTTPS 链接");
    } catch (reason) {
      setError(`链接无效：${reason.message}`);
      return;
    }

    setBusy(true);
    try {
      const label = IS_TAURI ? await invoke("create_instance", { url: parsed.href, speed: globalSpeed }) : `instance-${instances.length + 1}`;
      const labels = IS_TAURI ? await loadInstances() : [...instances, label];
      if (!IS_TAURI) setInstances(labels);
      setSpeeds((current) => ({ ...current, [label]: globalSpeed }));
      setSpeedDrafts((current) => ({ ...current, [label]: String(globalSpeed) }));
      setMaximized(null);
      setPage(Math.floor(Math.max(0, labels.indexOf(label)) / PAGE_SIZE));
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function close(label) {
    try {
      if (IS_TAURI) await invoke("close_instance", { label });
      if (maximized === label) setMaximized(null);
      if (IS_TAURI) await loadInstances();
      else setInstances((current) => current.filter((item) => item !== label));
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function reload(label) {
    try {
      if (IS_TAURI) await invoke("reload_instance", { label });
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }

  function parseSpeed(raw) {
    const speed = Number(raw);
    if (!raw.trim() || !Number.isFinite(speed) || speed <= 0) throw new Error("速度必须是大于 0 的数字");
    return speed;
  }

  async function applySpeed(label, raw) {
    try {
      const speed = parseSpeed(raw);
      if (IS_TAURI) await invoke("set_instance_speed", { label, speed });
      setSpeeds((current) => ({ ...current, [label]: speed }));
      setSpeedDrafts((current) => ({ ...current, [label]: String(speed) }));
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function applyGlobalSpeed(event) {
    event.preventDefault();
    try {
      const speed = parseSpeed(globalSpeedDraft);
      if (IS_TAURI) await Promise.all(instances.map((label) => invoke("set_instance_speed", { label, speed })));
      setGlobalSpeed(speed);
      setGlobalSpeedDraft(String(speed));
      setSpeeds(Object.fromEntries(instances.map((label) => [label, speed])));
      setSpeedDrafts(Object.fromEntries(instances.map((label) => [label, String(speed)])));
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }

  const gridCount = maximized ? 1 : pageItems.length;

  return (
    <main className="app-shell">
      {error && <div className="error" role="alert">{error}</div>}

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <div className="brand-mark"><Icon name="layers" /></div>
            <div className="brand-copy"><h1>Web Multi-Instance Monitor</h1><p>独立 WebView2 · 多画面监控</p></div>
          </div>

          <form className="url-form" onSubmit={createOne}>
            <label htmlFor="target-url"><Icon name="link" />页面链接</label>
            <textarea id="target-url" rows="3" value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} spellCheck="false" />
            <small>修改后，新创建的画面使用此链接；已有画面保持不变。</small>
          </form>

          <section className="count-card">
            <span className="eyebrow">ACTIVE FEEDS</span>
            <div><strong>{instances.length}</strong><span>个隔离画面</span></div>
          </section>

          <section className="side-section">
            <h2>隔离状态</h2>
            <div className="isolation-row"><span className="shield"><Icon name="shield" /></span><div><b>完全独立</b><small>Cookie · 缓存 · 本地存储 · 设备号</small></div></div>
            <ul className="isolation-list">
              <li><i />独立 WebView2 Profile 与设备号</li>
              <li><i />隐私模式已启用</li>
              <li><i />无扩展与自动填充</li>
            </ul>
          </section>

          <section className="side-section guide"><h2>画面操作</h2><p>每页最多显示 4 个画面。每个画面均可独立刷新、旋转、放大或关闭。</p></section>
          <button className="button primary side-create" onClick={createOne} disabled={busy}><Icon name="plus" />添加隔离画面</button>
        </aside>

        <section className="monitor-stage">
          <div className="stage-toolbar">
            <div><span className="eyebrow">LIVE MONITOR</span><h2>{maximized ? `隔离实例 ${instanceNumber(maximized)}` : "实时监控"}</h2></div>
            <div className="toolbar-actions">
              <form className="global-speed-control" onSubmit={applyGlobalSpeed}>
                <label htmlFor="global-speed">总速度</label>
                <input id="global-speed" type="number" min="0" step="any" value={globalSpeedDraft} onChange={(event) => setGlobalSpeedDraft(event.target.value)} aria-describedby="global-speed-help" />
                <span aria-hidden="true">×</span>
                <button type="submit">应用全部</button>
                <small id="global-speed-help">仅允许大于 0 的数字，无上限</small>
              </form>
              {maximized && <button className="button secondary" onClick={() => setMaximized(null)}><Icon name="collapse" />恢复监控墙</button>}
              {!maximized && pageCount > 1 && (
                <div className="pagination" aria-label="监控墙分页">
                  <button onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={page === 0} aria-label="上一页"><Icon name="left" /></button>
                  <span>{page + 1} / {pageCount}</span>
                  <button onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} disabled={page === pageCount - 1} aria-label="下一页"><Icon name="right" /></button>
                </div>
              )}
              <span className="status"><i />实时运行</span>
            </div>
          </div>

          {instances.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon"><Icon name="layers" /></div><h3>监控墙等待接入</h3><p>填写链接后，使用左侧按钮添加隔离画面。</p>
            </div>
          ) : (
            <div className={`monitor-grid count-${gridCount} ${maximized ? "maximized" : ""}`}>
              {pageItems.map((label) => (
                <article className="monitor-tile" key={label}>
                  <header className="tile-header">
                    <div className="tile-info">
                      <div className="tile-title"><span className="online-dot" /><b>隔离实例 {instanceNumber(label)}</b><small>#{String(instanceNumber(label)).padStart(2, "0")} · {rotations[label] ?? 0}°</small></div>
                      <form className="tile-speed-control" onSubmit={(event) => { event.preventDefault(); applySpeed(label, speedDrafts[label] ?? String(speeds[label] ?? globalSpeed)); }}>
                        <label htmlFor={`speed-${label}`}>速度</label>
                        <input id={`speed-${label}`} type="number" min="0" step="any" value={speedDrafts[label] ?? String(speeds[label] ?? globalSpeed)} onChange={(event) => setSpeedDrafts((current) => ({ ...current, [label]: event.target.value }))} />
                        <span aria-hidden="true">×</span>
                        <button type="submit" title="应用当前画面速度">应用</button>
                      </form>
                    </div>
                    <div className="tile-actions">
                      <button onClick={() => reload(label)} aria-label={`刷新隔离实例 ${instanceNumber(label)}`} title="刷新当前画面"><Icon name="refresh" /></button>
                      <button onClick={() => setRotations((current) => ({ ...current, [label]: ((current[label] ?? 0) + 90) % 360 }))} aria-label={`顺时针旋转隔离实例 ${instanceNumber(label)}`} title="顺时针旋转 90°"><Icon name="rotate" /></button>
                      <button onClick={() => setMaximized((current) => current === label ? null : label)} aria-label={`${maximized === label ? "恢复" : "放大"}隔离实例 ${instanceNumber(label)}`} title={maximized === label ? "恢复监控墙" : "放大画面"}><Icon name={maximized === label ? "collapse" : "expand"} /></button>
                      <button className="danger" onClick={() => close(label)} aria-label={`关闭隔离实例 ${instanceNumber(label)}`} title="关闭画面"><Icon name="close" /></button>
                    </div>
                  </header>
                  <div className="webview-host" ref={(node) => node ? hosts.current.set(label, node) : hosts.current.delete(label)}>{!IS_TAURI && <span>隔离网页画面 {instanceNumber(label)}</span>}</div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
