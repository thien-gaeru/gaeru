// =========================================================================
// GAERU Warehouse Barcode Station (Nghiệp vụ quét mã vạch kho hàng)
// =========================================================================
(function () {
  const viewPanel = document.querySelector("#barcode-view");
  if (!viewPanel) return;

  const escape = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Audio feedback synthesizer (Web Audio API)
  let audioCtx = null;
  function playBeep(type = "success") {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (type === "success") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, audioCtx.currentTime); // High clear A5 beep
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.12);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.12);
      } else if (type === "complete") {
        // Double triumphant beep
        osc.type = "triangle";
        osc.frequency.setValueAtTime(659.25, audioCtx.currentTime); // E5
        osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.1); // A5
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.28);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.28);
      } else {
        // Low error buzz
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(220, audioCtx.currentTime); // Low buzz
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.25);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.25);
      }
    } catch {}
  }

  // Active state
  const state = {
    activeTab: "lookup",
    soundEnabled: true,
    currentOrder: null,
    currentChecklist: [],
    verificationStatus: null,
    warehouses: []
  };

  // Render station skeleton
  function renderStation() {
    viewPanel.innerHTML = `
      <div class="barcode-station-wrapper" style="padding: 16px; max-width: 1280px; margin: 0 auto; font-family: inherit;">
        <!-- Header -->
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom: 20px; border-bottom: 1px solid var(--border-color, #e5e7eb); padding-bottom: 14px;">
          <div>
            <h2 style="margin:0; font-size:22px; font-weight:700; color:var(--text-color, #111827); display:flex; align-items:center; gap:8px;">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="2" height="16"></rect>
                <rect x="7" y="4" width="1" height="16"></rect>
                <rect x="10" y="4" width="3" height="16"></rect>
                <rect x="15" y="4" width="1" height="16"></rect>
                <rect x="18" y="4" width="3" height="16"></rect>
              </svg>
              Trạm Quét Mã Vạch Kho Hàng (Barcode Scanner)
            </h2>
            <p style="margin:4px 0 0 0; font-size:13px; color:var(--text-muted, #6b7280);">
              Hỗ trợ máy quét cầm tay USB/Bluetooth, camera và nhập liệu nhanh: Tra cứu, Kiểm tra đóng gói, Nhập kho, Kiểm kê và In tem nhãn.
            </p>
          </div>
          <div style="display:flex; align-items:center; gap:16px;">
            <label style="display:inline-flex; align-items:center; gap:6px; font-size:13px; cursor:pointer; user-select:none;">
              <input type="checkbox" id="barcode-sound-toggle" checked style="accent-color:#16a34a; width:16px; height:16px;">
              <span>🔊 Âm thanh phản hồi (Beep)</span>
            </label>
            <button type="button" class="secondary-button" id="barcode-refresh-metrics" style="padding:6px 12px; font-size:13px;">
              🔄 Làm mới số liệu
            </button>
          </div>
        </div>

        <!-- Shift Metrics summary banner -->
        <div id="barcode-metrics-banner" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin-bottom: 20px;">
          <div style="background:var(--card-bg, #ffffff); border:1px solid var(--border-color, #e5e7eb); border-radius:8px; padding:12px 16px;">
            <div style="font-size:12px; color:var(--text-muted, #6b7280); font-weight:600;">LƯỢT QUÉT HÔM NAY</div>
            <div id="metric-scans" style="font-size:24px; font-weight:800; color:#2563eb; margin-top:4px;">0</div>
          </div>
          <div style="background:var(--card-bg, #ffffff); border:1px solid var(--border-color, #e5e7eb); border-radius:8px; padding:12px 16px;">
            <div style="font-size:12px; color:var(--text-muted, #6b7280); font-weight:600;">ĐƠN ĐÓNG GÓI XONG</div>
            <div id="metric-packs" style="font-size:24px; font-weight:800; color:#16a34a; margin-top:4px;">0</div>
          </div>
          <div style="background:var(--card-bg, #ffffff); border:1px solid var(--border-color, #e5e7eb); border-radius:8px; padding:12px 16px;">
            <div style="font-size:12px; color:var(--text-muted, #6b7280); font-weight:600;">ĐƠN XUẤT KHO</div>
            <div id="metric-dispatches" style="font-size:24px; font-weight:800; color:#9333ea; margin-top:4px;">0</div>
          </div>
          <div style="background:var(--card-bg, #ffffff); border:1px solid var(--border-color, #e5e7eb); border-radius:8px; padding:12px 16px;">
            <div style="font-size:12px; color:var(--text-muted, #6b7280); font-weight:600;">LẦN NHẬP KHO NHANH</div>
            <div id="metric-inbounds" style="font-size:24px; font-weight:800; color:#ea580c; margin-top:4px;">0</div>
          </div>
          <div style="background:var(--card-bg, #ffffff); border:1px solid var(--border-color, #e5e7eb); border-radius:8px; padding:12px 16px;">
            <div style="font-size:12px; color:var(--text-muted, #6b7280); font-weight:600;">LẦN CÂN ĐỐI KIỂM KÊ</div>
            <div id="metric-counts" style="font-size:24px; font-weight:800; color:#0891b2; margin-top:4px;">0</div>
          </div>
        </div>

        <!-- Navigation Tabs -->
        <div class="barcode-tabs" style="display:flex; gap:8px; border-bottom:2px solid var(--border-color, #e5e7eb); margin-bottom:20px; overflow-x:auto;">
          <button type="button" class="barcode-tab-btn is-active" data-tab="lookup" style="padding:10px 18px; font-weight:600; font-size:14px; border:none; background:transparent; border-bottom:3px solid #2563eb; color:#2563eb; cursor:pointer;">
            🔍 Tra Cứu (Lookup)
          </button>
          <button type="button" class="barcode-tab-btn" data-tab="packing" style="padding:10px 18px; font-weight:600; font-size:14px; border:none; background:transparent; border-bottom:3px solid transparent; color:var(--text-muted, #6b7280); cursor:pointer;">
            📦 Đóng Gói & Xuất Kho
          </button>
          <button type="button" class="barcode-tab-btn" data-tab="inbound" style="padding:10px 18px; font-weight:600; font-size:14px; border:none; background:transparent; border-bottom:3px solid transparent; color:var(--text-muted, #6b7280); cursor:pointer;">
            📥 Nhập Kho Nhanh
          </button>
          <button type="button" class="barcode-tab-btn" data-tab="cycle_count" style="padding:10px 18px; font-weight:600; font-size:14px; border:none; background:transparent; border-bottom:3px solid transparent; color:var(--text-muted, #6b7280); cursor:pointer;">
            📊 Kiểm Kê Tồn Kho
          </button>
          <button type="button" class="barcode-tab-btn" data-tab="print" style="padding:10px 18px; font-weight:600; font-size:14px; border:none; background:transparent; border-bottom:3px solid transparent; color:var(--text-muted, #6b7280); cursor:pointer;">
            🏷️ In Tem Mã Vạch (Code 128)
          </button>
          <button type="button" class="barcode-tab-btn" data-tab="history" style="padding:10px 18px; font-weight:600; font-size:14px; border:none; background:transparent; border-bottom:3px solid transparent; color:var(--text-muted, #6b7280); cursor:pointer;">
            🕒 Lịch Sử Quét
          </button>
        </div>

        <!-- Global Master Scanner Input Box -->
        <div style="background:var(--card-bg, #ffffff); border:2px solid #3b82f6; border-radius:10px; padding:16px 20px; margin-bottom:20px; box-shadow:0 4px 12px rgba(59,130,246,0.08);">
          <form id="barcode-global-scan-form" style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
            <div style="flex:1; min-width:260px; position:relative;">
              <span style="position:absolute; left:12px; top:50%; transform:translateY(-50%); font-size:18px;">🎯</span>
              <input type="text" id="barcode-master-input" autofocus autocomplete="off" placeholder="Quét mã vạch hoặc gõ SKU / Mã đơn / Vận đơn rồi nhấn Enter..." style="width:100%; box-sizing:border-box; padding:12px 14px 12px 40px; font-size:16px; font-weight:600; font-family:ui-monospace, monospace; border:1px solid #d1d5db; border-radius:6px; outline:none;">
            </div>
            <button type="submit" class="primary-button" style="padding:12px 24px; font-size:15px; font-weight:700; background:#2563eb; color:#fff; border:none; border-radius:6px; cursor:pointer;">
              Quét / Tra Cứu
            </button>
            <button type="button" id="barcode-clear-input" class="secondary-button" style="padding:12px 16px; font-size:14px;">
              Xóa ô nhập
            </button>
          </form>
          <div id="barcode-scan-feedback" style="margin-top:10px; font-size:14px; font-weight:600; min-height:20px;"></div>
        </div>

        <!-- Tab 1: Lookup Panel -->
        <div id="tab-panel-lookup" class="barcode-tab-content">
          <div id="lookup-result-container" style="background:var(--card-bg, #ffffff); border:1px solid var(--border-color, #e5e7eb); border-radius:8px; padding:20px; min-height:160px; text-align:center; color:var(--text-muted, #6b7280);">
            <p style="font-size:15px; margin:20px 0;">Sẵn sàng nhận tín hiệu quét mã vạch. Vui lòng quét mã SKU sản phẩm, mã đơn hàng hoặc mã vận đơn.</p>
          </div>
        </div>

        <!-- Tab 2: Pack & Dispatch Panel -->
        <div id="tab-panel-packing" class="barcode-tab-content" hidden>
          <div style="display:grid; grid-template-columns:1fr; gap:16px;">
            <div style="background:var(--card-bg, #ffffff); border:1px solid var(--border-color, #e5e7eb); border-radius:8px; padding:20px;">
              <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:16px;">
                <div>
                  <h3 style="margin:0; font-size:18px; font-weight:700;">Kiểm Tra Đóng Gói Đơn Hàng (Pack Verification)</h3>
                  <p style="margin:4px 0 0; font-size:13px; color:var(--text-muted, #6b7280);">
                    Quét mã đơn hàng để nạp danh sách, sau đó quét từng món hàng để chống gửi nhầm hoặc thiếu món.
                  </p>
                </div>
                <div id="pack-order-status-badge"></div>
              </div>

              <!-- Order header info -->
              <div id="pack-order-header" style="background:var(--table-header-bg, #f9fafb); border:1px solid var(--border-color, #e5e7eb); border-radius:6px; padding:14px; margin-bottom:16px; display:none;"></div>

              <!-- Checklist table -->
              <div id="pack-checklist-container" style="overflow-x:auto;">
                <p style="color:var(--text-muted, #6b7280); font-style:italic;">Chưa chọn đơn hàng. Quét mã đơn hàng (VD: GA-...) để bắt đầu đóng gói.</p>
              </div>

              <!-- Dispatch action button -->
              <div id="pack-dispatch-box" style="margin-top:20px; padding-top:16px; border-top:1px solid var(--border-color, #e5e7eb); display:none; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
                <div>
                  <div style="font-weight:700; color:#16a34a; font-size:15px;" id="pack-completion-notice">✅ Đã kiểm tra đủ toàn bộ món hàng!</div>
                  <div style="font-size:13px; color:var(--text-muted, #6b7280);">Đơn hàng sẵn sàng xuất kho và bàn giao hãng vận chuyển.</div>
                </div>
                <button type="button" id="btn-dispatch-order" class="primary-button" style="background:#16a34a; font-size:15px; padding:10px 24px; font-weight:700;">
                  🚀 Xác Nhận Xuất Kho (Dispatch)
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Tab 3: Quick Inbound Panel -->
        <div id="tab-panel-inbound" class="barcode-tab-content" hidden>
          <div style="background:var(--card-bg, #ffffff); border:1px solid var(--border-color, #e5e7eb); border-radius:8px; padding:20px; max-width:640px;">
            <h3 style="margin:0 0 8px; font-size:18px; font-weight:700;">Nhập Kho Nhanh Bằng Máy Quét (Quick Inbound)</h3>
            <p style="margin:0 0 20px; font-size:13px; color:var(--text-muted, #6b7280);">
              Quét mã vạch sản phẩm, chọn kho đích và xác nhận số lượng để cộng thẳng vào số dư kho có lưu vết nhật ký.
            </p>
            <form id="form-quick-inbound">
              <div style="margin-bottom:14px;">
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px;">Mã vạch / SKU sản phẩm:</label>
                <input type="text" id="inbound-sku-input" required placeholder="Quét hoặc gõ SKU..." style="width:100%; box-sizing:border-box; padding:10px 12px; font-size:15px; font-family:monospace; border:1px solid #d1d5db; border-radius:6px;">
              </div>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px;">
                <div>
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px;">Kho tiếp nhận:</label>
                  <select id="inbound-warehouse-select" style="width:100%; box-sizing:border-box; padding:10px 12px; font-size:14px; border:1px solid #d1d5db; border-radius:6px;"></select>
                </div>
                <div>
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px;">Số lượng nhập:</label>
                  <input type="number" id="inbound-qty-input" required min="1" value="1" style="width:100%; box-sizing:border-box; padding:10px 12px; font-size:15px; font-weight:700; border:1px solid #d1d5db; border-radius:6px;">
                </div>
              </div>
              <div style="margin-bottom:20px;">
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px;">Lý do / Ghi chú nhập:</label>
                <input type="text" id="inbound-reason-input" value="Nhập kho nhanh qua máy quét mã vạch" style="width:100%; box-sizing:border-box; padding:10px 12px; font-size:14px; border:1px solid #d1d5db; border-radius:6px;">
              </div>
              <button type="submit" class="primary-button" style="width:100%; padding:12px; font-size:15px; font-weight:700; background:#ea580c;">
                📥 Xác Nhận Nhập Kho
              </button>
            </form>
            <div id="inbound-result" style="margin-top:16px;"></div>
          </div>
        </div>

        <!-- Tab 4: Cycle Count Panel -->
        <div id="tab-panel-cycle_count" class="barcode-tab-content" hidden>
          <div style="background:var(--card-bg, #ffffff); border:1px solid var(--border-color, #e5e7eb); border-radius:8px; padding:20px; max-width:640px;">
            <h3 style="margin:0 0 8px; font-size:18px; font-weight:700;">Kiểm Kê Cân Đối Tồn Kho (Cycle Count)</h3>
            <p style="margin:0 0 20px; font-size:13px; color:var(--text-muted, #6b7280);">
              Quét mã SKU trên kệ, kiểm tra số tồn sổ sách và nhập số lượng đếm thực tế để điều chỉnh cân bằng kho.
            </p>
            <form id="form-cycle-count">
              <div style="margin-bottom:14px;">
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px;">Mã vạch / SKU sản phẩm:</label>
                <input type="text" id="count-sku-input" required placeholder="Quét hoặc gõ SKU..." style="width:100%; box-sizing:border-box; padding:10px 12px; font-size:15px; font-family:monospace; border:1px solid #d1d5db; border-radius:6px;">
              </div>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px;">
                <div>
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px;">Kho kiểm kê:</label>
                  <select id="count-warehouse-select" style="width:100%; box-sizing:border-box; padding:10px 12px; font-size:14px; border:1px solid #d1d5db; border-radius:6px;"></select>
                </div>
                <div>
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px;">Số lượng thực tế (đã đếm):</label>
                  <input type="number" id="count-qty-input" required min="0" value="0" style="width:100%; box-sizing:border-box; padding:10px 12px; font-size:15px; font-weight:700; border:1px solid #d1d5db; border-radius:6px;">
                </div>
              </div>
              <div style="margin-bottom:20px;">
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px;">Lý do kiểm kê:</label>
                <input type="text" id="count-reason-input" value="Kiểm kê định kỳ qua máy quét mã vạch" style="width:100%; box-sizing:border-box; padding:10px 12px; font-size:14px; border:1px solid #d1d5db; border-radius:6px;">
              </div>
              <button type="submit" class="primary-button" style="width:100%; padding:12px; font-size:15px; font-weight:700; background:#0891b2;">
                📊 Cập Nhật Cân Đối Tồn Kho
              </button>
            </form>
            <div id="count-result" style="margin-top:16px;"></div>
          </div>
        </div>

        <!-- Tab 5: Print Labels Panel -->
        <div id="tab-panel-print" class="barcode-tab-content" hidden>
          <div style="background:var(--card-bg, #ffffff); border:1px solid var(--border-color, #e5e7eb); border-radius:8px; padding:20px;">
            <h3 style="margin:0 0 8px; font-size:18px; font-weight:700;">In Tem Mã Vạch Chuẩn Code 128 (Thermal Label Printer)</h3>
            <p style="margin:0 0 20px; font-size:13px; color:var(--text-muted, #6b7280);">
              Tạo vector SVG siêu nét, in trực tiếp ra máy in nhiệt (40×30mm, 50×30mm) hoặc máy in A4/A6 để dán lên bao bì sản phẩm.
            </p>
            <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:20px;">
              <input type="text" id="print-code-input" placeholder="Nhập mã SKU hoặc mã cần in (VD: K9-TYPEC)..." style="flex:1; min-width:240px; padding:10px 12px; font-family:monospace; font-size:15px; font-weight:600; border:1px solid #d1d5db; border-radius:6px;">
              <button type="button" id="btn-generate-barcode" class="primary-button" style="padding:10px 20px;">
                Tạo Tem Mã Vạch
              </button>
              <button type="button" id="btn-print-barcode" class="secondary-button" style="padding:10px 20px;" disabled>
                🖨️ In Tem Này
              </button>
            </div>
            <div id="print-preview-container" style="background:#f9fafb; border:2px dashed #d1d5db; border-radius:8px; padding:30px; text-align:center; min-height:160px; display:flex; flex-direction:column; align-items:center; justify-content:center;">
              <span style="color:#9ca3af;">Nhập mã và nhấn "Tạo Tem Mã Vạch" để xem bản in xem trước</span>
            </div>
          </div>
        </div>

        <!-- Tab 6: History & Shift Metrics -->
        <div id="tab-panel-history" class="barcode-tab-content" hidden>
          <div style="background:var(--card-bg, #ffffff); border:1px solid var(--border-color, #e5e7eb); border-radius:8px; padding:20px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
              <h3 style="margin:0; font-size:18px; font-weight:700;">Nhật Ký Quét Mã Vạch Thời Gian Thực</h3>
              <button type="button" id="btn-refresh-history" class="secondary-button" style="padding:6px 12px; font-size:13px;">
                Tải lại nhật ký
              </button>
            </div>
            <div id="barcode-history-table-container" style="overflow-x:auto;">
              <p style="color:var(--text-muted, #6b7280);">Đang tải nhật ký...</p>
            </div>
          </div>
        </div>
      </div>
    `;

    // Hook tab switches
    viewPanel.querySelectorAll(".barcode-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        switchTab(tab);
      });
    });

    // Sound toggle
    const soundToggle = viewPanel.querySelector("#barcode-sound-toggle");
    if (soundToggle) {
      soundToggle.addEventListener("change", (e) => {
        state.soundEnabled = e.target.checked;
      });
    }

    // Refresh metrics button
    const refreshBtn = viewPanel.querySelector("#barcode-refresh-metrics");
    if (refreshBtn) refreshBtn.addEventListener("click", loadMetrics);

    // Clear input
    const clearBtn = viewPanel.querySelector("#barcode-clear-input");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        const input = viewPanel.querySelector("#barcode-master-input");
        if (input) {
          input.value = "";
          input.focus();
        }
      });
    }

    // Global Master Scanner Form submit
    const globalForm = viewPanel.querySelector("#barcode-global-scan-form");
    if (globalForm) {
      globalForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = viewPanel.querySelector("#barcode-master-input");
        const code = input ? input.value.trim() : "";
        if (!code) return;
        await handleBarcodeScan(code);
      });
    }

    // Quick Inbound form
    const inboundForm = viewPanel.querySelector("#form-quick-inbound");
    if (inboundForm) {
      inboundForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        await handleQuickInbound();
      });
    }

    // Cycle Count form
    const countForm = viewPanel.querySelector("#form-cycle-count");
    if (countForm) {
      countForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        await handleCycleCount();
      });
    }

    // Print label buttons
    const genBtn = viewPanel.querySelector("#btn-generate-barcode");
    if (genBtn) {
      genBtn.addEventListener("click", async () => {
        const code = viewPanel.querySelector("#print-code-input").value.trim();
        if (code) await generatePrintPreview(code);
      });
    }
    const printBtn = viewPanel.querySelector("#btn-print-barcode");
    if (printBtn) {
      printBtn.addEventListener("click", () => {
        window.print();
      });
    }

    // Dispatch button
    const dispatchBtn = viewPanel.querySelector("#btn-dispatch-order");
    if (dispatchBtn) {
      dispatchBtn.addEventListener("click", handleDispatchOrder);
    }

    // History refresh
    const historyBtn = viewPanel.querySelector("#btn-refresh-history");
    if (historyBtn) {
      historyBtn.addEventListener("click", loadHistory);
    }
  }

  function switchTab(tab) {
    state.activeTab = tab;
    viewPanel.querySelectorAll(".barcode-tab-btn").forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle("is-active", active);
      b.style.borderBottom = active ? "3px solid #2563eb" : "3px solid transparent";
      b.style.color = active ? "#2563eb" : "var(--text-muted, #6b7280)";
    });

    viewPanel.querySelectorAll(".barcode-tab-content").forEach((p) => {
      p.hidden = p.id !== `tab-panel-${tab}`;
    });

    if (tab === "history") loadHistory();
    // Keep focus on master scanner
    const masterInput = viewPanel.querySelector("#barcode-master-input");
    if (masterInput) masterInput.focus();
  }

  // Handle barcode scanned from master input
  async function handleBarcodeScan(code) {
    const feedback = viewPanel.querySelector("#barcode-scan-feedback");
    feedback.innerHTML = `<span style="color:#2563eb;">⏳ Đang phân giải mã [${escape(code)}]...</span>`;

    try {
      // In packing tab with an active order loaded: treat scan as packing item
      if (state.activeTab === "packing" && state.currentOrder && state.verificationStatus !== "dispatched") {
        await verifyPackScan(code);
        return;
      }

      const res = await window.GAERUAdmin.request(`/api/gaeru_ceo/barcode/scan/${encodeURIComponent(code)}`);
      if (state.soundEnabled) playBeep("success");

      if (res.type === "sku") {
        feedback.innerHTML = `<span style="color:#16a34a;">✅ Đã nhận diện SKU: <strong>${escape(res.variant.sku)}</strong> (${escape(res.variant.productName)})</span>`;
        renderSkuLookup(res);
        if (state.activeTab !== "lookup") switchTab("lookup");
      } else if (res.type === "order") {
        feedback.innerHTML = `<span style="color:#16a34a;">✅ Đã nhận diện Đơn Hàng: <strong>${escape(res.order.orderNumber)}</strong> - ${escape(res.order.customerName)}</span>`;
        loadOrderIntoPacking(res);
        switchTab("packing");
      } else if (res.type === "waybill") {
        feedback.innerHTML = `<span style="color:#16a34a;">✅ Đã nhận diện Vận Đơn: <strong>${escape(res.shipment.tracking_number)}</strong> (Đơn ${escape(res.order.orderNumber)})</span>`;
        renderWaybillLookup(res);
        if (state.activeTab !== "lookup") switchTab("lookup");
      } else {
        if (state.soundEnabled) playBeep("error");
        feedback.innerHTML = `<span style="color:#dc2626;">⚠️ Không tìm thấy đối tượng nào khớp với mã [${escape(code)}]</span>`;
        viewPanel.querySelector("#lookup-result-container").innerHTML = `
          <div style="padding:20px; color:#dc2626;">
            <h4>Không tìm thấy đối tượng</h4>
            <p>Mã vừa quét <code>${escape(code)}</code> không trùng với bất kỳ SKU, mã vạch nhà sản xuất, mã đơn hàng hay mã vận đơn nào trong hệ thống.</p>
          </div>
        `;
      }

      loadMetrics();
      // Select input text for consecutive scans
      const input = viewPanel.querySelector("#barcode-master-input");
      if (input) {
        input.select();
        input.focus();
      }
    } catch (err) {
      if (state.soundEnabled) playBeep("error");
      feedback.innerHTML = `<span style="color:#dc2626;">❌ Lỗi: ${escape(err.message)}</span>`;
    }
  }

  // Render SKU details in lookup tab
  function renderSkuLookup(data) {
    const v = data.variant;
    const stocks = data.warehouseStocks || [];
    const movs = data.recentMovements || [];

    const stockRows = stocks.map(s => `
      <tr>
        <td style="padding:8px 12px; border-bottom:1px solid #e5e7eb;"><strong>${escape(s.warehouseName)}</strong> (${escape(s.warehouseCode)})</td>
        <td style="padding:8px 12px; border-bottom:1px solid #e5e7eb; text-align:right; font-weight:700; color:${s.quantity > 0 ? '#16a34a' : '#dc2626'}; font-size:15px;">
          ${s.quantity}
        </td>
      </tr>
    `).join("");

    const movRows = movs.map(m => `
      <tr style="font-size:12px;">
        <td style="padding:6px 10px; border-bottom:1px solid #f3f4f6;">${escape(new Date(m.createdAt).toLocaleString("vi-VN"))}</td>
        <td style="padding:6px 10px; border-bottom:1px solid #f3f4f6;">${escape(m.type)}</td>
        <td style="padding:6px 10px; border-bottom:1px solid #f3f4f6; text-align:right; font-weight:700; color:${m.delta >= 0 ? '#16a34a' : '#dc2626'};">${m.delta > 0 ? '+' : ''}${m.delta}</td>
        <td style="padding:6px 10px; border-bottom:1px solid #f3f4f6;">${escape(m.reason || '-')}</td>
        <td style="padding:6px 10px; border-bottom:1px solid #f3f4f6;">${escape(m.actor || '-')}</td>
      </tr>
    `).join("");

    viewPanel.querySelector("#lookup-result-container").innerHTML = `
      <div style="text-align:left;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:16px; margin-bottom:16px;">
          <div>
            <span style="display:inline-block; background:#dbeafe; color:#1e40af; font-size:12px; font-weight:700; padding:3px 8px; border-radius:4px; margin-bottom:6px;">SẢN PHẨM / BIẾN THỂ</span>
            <h3 style="margin:0; font-size:20px; font-weight:800;">${escape(v.productName)} - ${escape(v.name)}</h3>
            <div style="font-family:monospace; font-size:14px; color:#4b5563; margin-top:4px;">
              SKU: <strong>${escape(v.sku)}</strong> ${v.barcode ? `· Barcode: <strong>${escape(v.barcode)}</strong>` : ''}
            </div>
            <div style="font-size:15px; font-weight:700; color:#ea580c; margin-top:4px;">
              Giá niêm yết: ${(v.priceVnd || 0).toLocaleString("vi-VN")} đ
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:13px; color:#6b7280; font-weight:600;">TỔNG TỒN KHẢ DỤNG</div>
            <div style="font-size:28px; font-weight:800; color:#16a34a;">${v.stockQuantity}</div>
            <button type="button" class="secondary-button" id="btn-quick-print-sku" style="margin-top:8px; padding:6px 12px; font-size:12px;">
              🏷️ In tem SKU này
            </button>
          </div>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:16px;">
          <!-- Warehouse stock breakdown -->
          <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:6px; padding:12px;">
            <h4 style="margin:0 0 10px 0; font-size:14px; font-weight:700;">Tồn Kho Theo Chi Nhánh</h4>
            <table style="width:100%; border-collapse:collapse; font-size:13px;">
              <thead>
                <tr style="background:#e5e7eb; text-align:left;">
                  <th style="padding:6px 10px;">Kho hàng</th>
                  <th style="padding:6px 10px; text-align:right;">Số lượng</th>
                </tr>
              </thead>
              <tbody>${stockRows || '<tr><td colspan="2" style="padding:8px;">Chưa có dữ liệu kho</td></tr>'}</tbody>
            </table>
          </div>

          <!-- Fast action shortcuts -->
          <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:6px; padding:12px; display:flex; flex-direction:column; justify-content:center; gap:10px;">
            <h4 style="margin:0; font-size:14px; font-weight:700;">Hành Động Nhanh Với SKU Này</h4>
            <button type="button" class="secondary-button" id="btn-jump-inbound" style="text-align:left; padding:8px 12px; font-weight:600;">
              📥 Đi tới Nhập kho cho SKU [${escape(v.sku)}]
            </button>
            <button type="button" class="secondary-button" id="btn-jump-count" style="text-align:left; padding:8px 12px; font-weight:600;">
              📊 Đi tới Kiểm kê tồn kho SKU [${escape(v.sku)}]
            </button>
          </div>
        </div>

        <!-- Recent movements -->
        <div style="margin-top:20px;">
          <h4 style="margin:0 0 8px 0; font-size:14px; font-weight:700;">Lịch Sử Dịch Chuyển Kho Gần Nhất (5 lần)</h4>
          <table style="width:100%; border-collapse:collapse;">
            <thead>
              <tr style="background:#f3f4f6; text-align:left; font-size:12px;">
                <th style="padding:6px 10px;">Thời gian</th>
                <th style="padding:6px 10px;">Loại</th>
                <th style="padding:6px 10px; text-align:right;">Biến động</th>
                <th style="padding:6px 10px;">Lý do</th>
                <th style="padding:6px 10px;">Người thực hiện</th>
              </tr>
            </thead>
            <tbody>${movRows || '<tr><td colspan="5" style="padding:8px; text-align:center;">Chưa có dịch chuyển</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    `;

    // Hook buttons
    const jumpInbound = viewPanel.querySelector("#btn-jump-inbound");
    if (jumpInbound) {
      jumpInbound.addEventListener("click", () => {
        viewPanel.querySelector("#inbound-sku-input").value = v.sku;
        switchTab("inbound");
      });
    }
    const jumpCount = viewPanel.querySelector("#btn-jump-count");
    if (jumpCount) {
      jumpCount.addEventListener("click", () => {
        viewPanel.querySelector("#count-sku-input").value = v.sku;
        viewPanel.querySelector("#count-qty-input").value = v.stockQuantity;
        switchTab("cycle_count");
      });
    }
    const quickPrint = viewPanel.querySelector("#btn-quick-print-sku");
    if (quickPrint) {
      quickPrint.addEventListener("click", async () => {
        viewPanel.querySelector("#print-code-input").value = v.sku;
        switchTab("print");
        await generatePrintPreview(v.sku);
      });
    }
  }

  // Render Waybill details
  function renderWaybillLookup(data) {
    const s = data.shipment;
    const o = data.order;
    viewPanel.querySelector("#lookup-result-container").innerHTML = `
      <div style="text-align:left;">
        <span style="display:inline-block; background:#e0e7ff; color:#3730a3; font-size:12px; font-weight:700; padding:3px 8px; border-radius:4px; margin-bottom:6px;">VẬN ĐƠN HÃNG VẬN CHUYỂN</span>
        <h3 style="margin:0; font-size:20px; font-weight:800;">Mã vận đơn: <code>${escape(s.tracking_number)}</code> (${escape(s.carrier_id?.toUpperCase())})</h3>
        <p style="margin:6px 0 16px; font-size:14px; color:#4b5563;">
          Trạng thái hãng: <strong>${escape(s.status)}</strong> · Thu hộ COD: ${(s.cod_amount_vnd || 0).toLocaleString("vi-VN")} đ
        </p>
        <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:6px; padding:14px;">
          <h4 style="margin:0 0 6px; font-size:14px; font-weight:700;">Đơn Hàng Gốc: #${escape(o.orderNumber)}</h4>
          <p style="margin:0; font-size:13px;">Khách hàng: <strong>${escape(o.customerName)}</strong> - ${escape(o.phone)}</p>
          <p style="margin:4px 0 0; font-size:13px;">Địa chỉ nhận: ${escape(o.address)}, ${escape(o.city)}</p>
        </div>
      </div>
    `;
  }

  // Load Order into Packing tab
  function loadOrderIntoPacking(res) {
    state.currentOrder = res.order;
    const ver = res.verification;
    state.verificationStatus = ver.status;
    state.currentChecklist = Array.isArray(ver.items_checklist) ? ver.items_checklist : [];

    const header = viewPanel.querySelector("#pack-order-header");
    header.style.display = "block";
    header.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
        <div>
          <h4 style="margin:0; font-size:16px; font-weight:800;">Đơn #${escape(res.order.orderNumber)}</h4>
          <div style="font-size:13px; color:#4b5563; margin-top:4px;">
            Khách hàng: <strong>${escape(res.order.customerName)}</strong> (${escape(res.order.phone)})
          </div>
          <div style="font-size:13px; color:#6b7280; margin-top:2px;">
            Địa chỉ giao: ${escape(res.order.address)}, ${escape(res.order.city)}
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:13px; font-weight:700; color:#1e40af;">Tổng tiền: ${(res.order.totalVnd || 0).toLocaleString("vi-VN")} đ</div>
          <div style="font-size:12px; color:#6b7280;">Thanh toán: <strong>${escape(res.order.paymentMethod)}</strong> (${escape(res.order.paymentStatus)})</div>
          <div style="margin-top:6px; font-size:14px; font-weight:800; color:#2563eb;">
            Tiến độ: <span id="pack-progress-text">${ver.scanned_items} / ${ver.total_items} món</span>
          </div>
        </div>
      </div>
    `;

    renderChecklist();
  }

  function renderChecklist() {
    const listContainer = viewPanel.querySelector("#pack-checklist-container");
    const badge = viewPanel.querySelector("#pack-order-status-badge");
    const dispatchBox = viewPanel.querySelector("#pack-dispatch-box");

    if (!state.currentChecklist || state.currentChecklist.length === 0) {
      listContainer.innerHTML = `<p style="color:#6b7280;">Không có món hàng nào trong đơn này.</p>`;
      return;
    }

    const isAllScanned = state.currentChecklist.every(it => it.scannedQuantity >= it.requiredQuantity);

    badge.innerHTML = state.verificationStatus === "dispatched"
      ? `<span style="background:#f3e8ff; color:#7e22ce; font-weight:700; font-size:13px; padding:4px 10px; border-radius:6px;">🚀 ĐÃ XUẤT KHO</span>`
      : isAllScanned
      ? `<span style="background:#dcfce7; color:#15803d; font-weight:700; font-size:13px; padding:4px 10px; border-radius:6px;">✅ ĐÃ KIỂM ĐỦ MÓN</span>`
      : `<span style="background:#fef3c7; color:#b45309; font-weight:700; font-size:13px; padding:4px 10px; border-radius:6px;">⏳ ĐANG ĐÓNG GÓI</span>`;

    const rows = state.currentChecklist.map((it, idx) => {
      const done = it.scannedQuantity >= it.requiredQuantity;
      return `
        <tr style="background:${done ? '#f0fdf4' : '#ffffff'}; border-bottom:1px solid #e5e7eb;">
          <td style="padding:10px 14px; font-weight:700; font-size:16px; text-align:center; color:${done ? '#16a34a' : '#d1d5db'};">
            ${done ? '✅' : '⚪'}
          </td>
          <td style="padding:10px 14px;">
            <div style="font-weight:700; font-size:14px;">${escape(it.productName)}</div>
            <div style="font-size:13px; color:#4b5563;">Phân loại: ${escape(it.variantName)}</div>
            <div style="font-family:monospace; font-size:12px; color:#6b7280;">
              SKU: <strong>${escape(it.sku)}</strong> ${it.barcode ? `· Mã vạch: ${escape(it.barcode)}` : ''}
            </div>
          </td>
          <td style="padding:10px 14px; text-align:center; font-weight:600; font-size:14px;">${it.requiredQuantity}</td>
          <td style="padding:10px 14px; text-align:center; font-weight:800; font-size:16px; color:${done ? '#16a34a' : '#ea580c'};">
            ${it.scannedQuantity}
          </td>
          <td style="padding:10px 14px; text-align:right;">
            ${done
              ? '<span style="color:#16a34a; font-weight:700; font-size:13px;">Đủ hàng</span>'
              : `<span style="color:#ea580c; font-weight:600; font-size:13px;">Thiếu ${it.requiredQuantity - it.scannedQuantity}</span>`}
          </td>
        </tr>
      `;
    }).join("");

    listContainer.innerHTML = `
      <table style="width:100%; border-collapse:collapse; text-align:left;">
        <thead>
          <tr style="background:#f3f4f6; font-size:13px; color:#4b5563;">
            <th style="padding:8px 14px; width:40px; text-align:center;">Trạng thái</th>
            <th style="padding:8px 14px;">Món hàng</th>
            <th style="padding:8px 14px; text-align:center; width:90px;">Yêu cầu</th>
            <th style="padding:8px 14px; text-align:center; width:90px;">Đã quét</th>
            <th style="padding:8px 14px; text-align:right; width:120px;">Tình trạng</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    // Show/hide dispatch button
    if (dispatchBox) {
      if (isAllScanned && state.verificationStatus !== "dispatched") {
        dispatchBox.style.display = "flex";
      } else {
        dispatchBox.style.display = "none";
      }
    }
  }

  // Scan pack verify single item
  async function verifyPackScan(code) {
    if (!state.currentOrder) return;
    const feedback = viewPanel.querySelector("#barcode-scan-feedback");

    try {
      const res = await window.GAERUAdmin.request(`/api/gaeru_ceo/barcode/pack-verify`, {
        method: "POST",
        body: JSON.stringify({
          orderId: state.currentOrder.id,
          scannedCode: code
        })
      });

      if (res.ok) {
        state.verificationStatus = res.verification.status;
        state.currentChecklist = Array.isArray(res.verification.items_checklist) ? res.verification.items_checklist : [];
        renderChecklist();

        if (res.isComplete) {
          if (state.soundEnabled) playBeep("complete");
          feedback.innerHTML = `<span style="color:#16a34a; font-size:15px; font-weight:800;">🎉 ĐÃ QUÉT ĐỦ TOÀN BỘ MÓN HÀNG TRONG ĐƠN #${escape(res.orderNumber)}! Sẵn sàng xuất kho.</span>`;
        } else {
          if (state.soundEnabled) playBeep("success");
          feedback.innerHTML = `<span style="color:#16a34a;">✅ Đã quét khớp món: <strong>${escape(res.matchedItem.sku)}</strong> (${res.matchedItem.scannedQuantity}/${res.matchedItem.requiredQuantity})</span>`;
        }
      } else {
        if (state.soundEnabled) playBeep("error");
        feedback.innerHTML = `<span style="color:#dc2626; font-size:15px; font-weight:800;">⚠️ ${escape(res.error)}</span>`;
      }

      loadMetrics();
      const input = viewPanel.querySelector("#barcode-master-input");
      if (input) {
        input.value = "";
        input.focus();
      }
    } catch (err) {
      if (state.soundEnabled) playBeep("error");
      feedback.innerHTML = `<span style="color:#dc2626;">❌ ${escape(err.message)}</span>`;
    }
  }

  // Dispatch order
  async function handleDispatchOrder() {
    if (!state.currentOrder) return;
    const btn = viewPanel.querySelector("#btn-dispatch-order");
    btn.disabled = true;
    btn.textContent = "Đang xử lý xuất kho...";

    try {
      const res = await window.GAERUAdmin.request(`/api/gaeru_ceo/barcode/dispatch`, {
        method: "POST",
        body: JSON.stringify({
          orderId: state.currentOrder.id
        })
      });

      if (state.soundEnabled) playBeep("complete");
      state.verificationStatus = "dispatched";
      renderChecklist();
      window.GAERUAdmin.showGlobal(`Đã xuất kho đơn hàng #${escape(res.orderNumber)} thành công!`);
      btn.style.display = "none";
      loadMetrics();
    } catch (err) {
      if (state.soundEnabled) playBeep("error");
      alert(err.message);
      btn.disabled = false;
      btn.textContent = "🚀 Xác Nhận Xuất Kho (Dispatch)";
    }
  }

  // Quick Inbound Submit
  async function handleQuickInbound() {
    const sku = viewPanel.querySelector("#inbound-sku-input").value.trim();
    const warehouseId = viewPanel.querySelector("#inbound-warehouse-select").value;
    const quantity = parseInt(viewPanel.querySelector("#inbound-qty-input").value, 10);
    const reason = viewPanel.querySelector("#inbound-reason-input").value.trim();
    const resultBox = viewPanel.querySelector("#inbound-result");

    resultBox.innerHTML = `<span style="color:#2563eb;">Đang ghi nhận nhập kho...</span>`;

    try {
      const res = await window.GAERUAdmin.request(`/api/gaeru_ceo/barcode/receive`, {
        method: "POST",
        body: JSON.stringify({ code: sku, warehouseId, quantity, reason })
      });

      if (state.soundEnabled) playBeep("complete");
      resultBox.innerHTML = `
        <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px; padding:12px; color:#166534;">
          <h4 style="margin:0 0 6px;">✅ Nhập kho thành công!</h4>
          <p style="margin:0; font-size:13px;">SKU: <strong>${escape(res.sku)}</strong> (${escape(res.productName)})</p>
          <p style="margin:4px 0 0; font-size:13px;">Kho: <strong>${escape(res.warehouseCode)}</strong> · Số lượng vừa nhập: <strong>+${res.receivedQuantity}</strong></p>
          <p style="margin:4px 0 0; font-size:13px;">Tồn kho chi nhánh: <strong>${res.beforeQuantity} ➔ ${res.newQuantity}</strong> (Tổng toàn hệ thống: ${res.aggregateQuantity})</p>
        </div>
      `;
      viewPanel.querySelector("#inbound-sku-input").value = "";
      viewPanel.querySelector("#inbound-qty-input").value = 1;
      loadMetrics();
    } catch (err) {
      if (state.soundEnabled) playBeep("error");
      resultBox.innerHTML = `<div style="background:#fef2f2; border:1px solid #fecaca; border-radius:6px; padding:12px; color:#991b1b;">❌ ${escape(err.message)}</div>`;
    }
  }

  // Cycle Count Submit
  async function handleCycleCount() {
    const sku = viewPanel.querySelector("#count-sku-input").value.trim();
    const warehouseId = viewPanel.querySelector("#count-warehouse-select").value;
    const actualQuantity = parseInt(viewPanel.querySelector("#count-qty-input").value, 10);
    const reason = viewPanel.querySelector("#count-reason-input").value.trim();
    const resultBox = viewPanel.querySelector("#count-result");

    resultBox.innerHTML = `<span style="color:#2563eb;">Đang điều chỉnh cân đối tồn kho...</span>`;

    try {
      const res = await window.GAERUAdmin.request(`/api/gaeru_ceo/barcode/cycle-count`, {
        method: "POST",
        body: JSON.stringify({ code: sku, warehouseId, actualQuantity, reason })
      });

      if (state.soundEnabled) playBeep("complete");
      const deltaColor = res.delta >= 0 ? "#166534" : "#991b1b";
      resultBox.innerHTML = `
        <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px; padding:12px; color:#166534;">
          <h4 style="margin:0 0 6px;">✅ Cập nhật kiểm kê thành công!</h4>
          <p style="margin:0; font-size:13px;">SKU: <strong>${escape(res.sku)}</strong> (Kho ${escape(res.warehouseCode)})</p>
          <p style="margin:4px 0 0; font-size:13px;">Số tồn trước kiểm kê: <strong>${res.beforeQuantity}</strong> ➔ Số thực tế sau kiểm kê: <strong>${res.actualQuantity}</strong></p>
          <p style="margin:4px 0 0; font-size:13px; font-weight:700; color:${deltaColor};">Chênh lệch điều chỉnh: ${res.delta > 0 ? '+' : ''}${res.delta}</p>
        </div>
      `;
      loadMetrics();
    } catch (err) {
      if (state.soundEnabled) playBeep("error");
      resultBox.innerHTML = `<div style="background:#fef2f2; border:1px solid #fecaca; border-radius:6px; padding:12px; color:#991b1b;">❌ ${escape(err.message)}</div>`;
    }
  }

  // Print label preview
  async function generatePrintPreview(code) {
    const container = viewPanel.querySelector("#print-preview-container");
    const printBtn = viewPanel.querySelector("#btn-print-barcode");
    container.innerHTML = `<span style="color:#2563eb;">Đang sinh vector mã vạch...</span>`;

    try {
      const res = await window.GAERUAdmin.request(`/api/gaeru_ceo/barcode/render?code=${encodeURIComponent(code)}&height=70&moduleWidth=2`);
      container.innerHTML = `
        <div id="barcode-printable-area" style="background:#ffffff; padding:16px; border:1px solid #e5e7eb; border-radius:6px; display:inline-block; box-shadow:0 2px 8px rgba(0,0,0,0.06);">
          ${res.svg}
        </div>
        <p style="margin-top:12px; font-size:13px; color:#6b7280;">Chuẩn Code 128 (Subset B) · Phù hợp tem nhiệt 50×30mm / 40×30mm</p>
      `;
      printBtn.disabled = false;
    } catch (err) {
      container.innerHTML = `<span style="color:#dc2626;">❌ ${escape(err.message)}</span>`;
      printBtn.disabled = true;
    }
  }

  // History loader
  async function loadHistory() {
    const container = viewPanel.querySelector("#barcode-history-table-container");
    container.innerHTML = `<p style="color:#6b7280;">Đang tải nhật ký quét...</p>`;

    try {
      const res = await window.GAERUAdmin.request(`/api/gaeru_ceo/barcode/history?limit=30`);
      const logs = res.logs || [];

      if (logs.length === 0) {
        container.innerHTML = `<p style="color:#6b7280; font-style:italic;">Chưa có lượt quét nào được ghi nhận.</p>`;
        return;
      }

      const rows = logs.map(l => {
        let actionBadge = `<span style="background:#e5e7eb; padding:2px 6px; border-radius:4px;">${escape(l.action)}</span>`;
        if (l.action === "lookup") actionBadge = `<span style="background:#dbeafe; color:#1e40af; padding:2px 6px; border-radius:4px; font-weight:600;">Tra cứu</span>`;
        if (l.action === "inbound_receive") actionBadge = `<span style="background:#ffedd5; color:#9a3412; padding:2px 6px; border-radius:4px; font-weight:600;">Nhập kho (+${l.quantity})</span>`;
        if (l.action === "cycle_count") actionBadge = `<span style="background:#cffafe; color:#155e75; padding:2px 6px; border-radius:4px; font-weight:600;">Kiểm kê (= ${l.quantity})</span>`;
        if (l.action === "pack_verify") actionBadge = `<span style="background:#dcfce7; color:#166534; padding:2px 6px; border-radius:4px; font-weight:600;">Kiểm đóng gói</span>`;
        if (l.action === "outbound_dispatch") actionBadge = `<span style="background:#f3e8ff; color:#6b21a8; padding:2px 6px; border-radius:4px; font-weight:600;">Xuất kho</span>`;

        return `
          <tr style="border-bottom:1px solid #f3f4f6; font-size:13px;">
            <td style="padding:8px 12px; font-family:monospace;">${escape(new Date(l.created_at).toLocaleString("vi-VN"))}</td>
            <td style="padding:8px 12px; font-family:monospace; font-weight:700;">${escape(l.code)}</td>
            <td style="padding:8px 12px;"><span style="text-transform:uppercase; font-size:11px; font-weight:700; color:#4b5563;">${escape(l.entity_type)}</span></td>
            <td style="padding:8px 12px;">${actionBadge}</td>
            <td style="padding:8px 12px;">${escape(l.scanned_by || 'scanner')}</td>
          </tr>
        `;
      }).join("");

      container.innerHTML = `
        <table style="width:100%; border-collapse:collapse; text-align:left;">
          <thead>
            <tr style="background:#f9fafb; font-size:12px; color:#4b5563;">
              <th style="padding:8px 12px;">Thời gian</th>
              <th style="padding:8px 12px;">Mã quét</th>
              <th style="padding:8px 12px;">Loại đối tượng</th>
              <th style="padding:8px 12px;">Nghiệp vụ</th>
              <th style="padding:8px 12px;">Nhân viên</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    } catch (err) {
      container.innerHTML = `<p style="color:#dc2626;">Lỗi tải nhật ký: ${escape(err.message)}</p>`;
    }
  }

  // Load shift metrics
  async function loadMetrics() {
    try {
      const res = await window.GAERUAdmin.request(`/api/gaeru_ceo/barcode/history?limit=1`);
      const m = res.metrics || {};
      const elScans = viewPanel.querySelector("#metric-scans");
      if (elScans) elScans.textContent = m.total_scans_today || 0;
      const elPacks = viewPanel.querySelector("#metric-packs");
      if (elPacks) elPacks.textContent = m.packs_today || 0;
      const elDisp = viewPanel.querySelector("#metric-dispatches");
      if (elDisp) elDisp.textContent = m.dispatches_today || 0;
      const elInb = viewPanel.querySelector("#metric-inbounds");
      if (elInb) elInb.textContent = m.inbounds_today || 0;
      const elCounts = viewPanel.querySelector("#metric-counts");
      if (elCounts) elCounts.textContent = m.cycle_counts_today || 0;
    } catch {}
  }

  // Load warehouses for dropdowns
  async function loadWarehouses() {
    try {
      const res = await window.GAERUAdmin.request(`/api/gaeru_ceo/warehouses`);
      const whList = Array.isArray(res) ? res : res.warehouses || [];
      state.warehouses = whList;
      const opts = whList.map(w => `<option value="${escape(w.id)}">${escape(w.name)} (${escape(w.code)})</option>`).join("");
      const inSel = viewPanel.querySelector("#inbound-warehouse-select");
      if (inSel) inSel.innerHTML = opts || `<option value="">Kho chính</option>`;
      const ctSel = viewPanel.querySelector("#count-warehouse-select");
      if (ctSel) ctSel.innerHTML = opts || `<option value="">Kho chính</option>`;
    } catch {}
  }

  // Initialize
  renderStation();
  loadMetrics();
  loadWarehouses();

  // Re-focus master input when view is opened
  const observer = new MutationObserver(() => {
    if (!viewPanel.hidden) {
      loadMetrics();
      const master = viewPanel.querySelector("#barcode-master-input");
      if (master) setTimeout(() => master.focus(), 100);
    }
  });
  observer.observe(viewPanel, { attributes: true, attributeFilter: ["hidden"] });
})();
