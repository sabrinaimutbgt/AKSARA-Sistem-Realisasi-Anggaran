const fallbackUnits = [
  'Pimpinan',
  'HRD',
  'Perusahaan',
  'Kesma',
  'Sekretariat',
  'PSDM',
  'Humas',
  'Lainnya'
].map((nama) => ({ id: nama, nama }));

const fallbackCategories = [
  'Kas',
  'Iuran',
  'Dana Dekanat',
  'Sponsor',
  'Donasi',
  'Lainnya'
].map((nama) => ({
  id: nama,
  nama,
  warna: '#c66d91'
}));

const state = {
  budgets: [],
  units: fallbackUnits,
  categories: fallbackCategories,
  profiles: [],
  profile: null,
  publicMode: true
};

const supabaseConfig = window.SUPABASE_CONFIG;

const supabaseRestUrl =
  `${supabaseConfig.url.replace(/\/$/, '')}/rest/v1`;

const supabaseAuthUrl =
  `${supabaseConfig.url.replace(/\/$/, '')}/auth/v1`;

let authSession = JSON.parse(
  localStorage.getItem('aksara-auth-session') || 'null'
);

let authMode = 'signin';

let selectedYear = String(new Date().getFullYear());

const currency = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0
});

const dateFormat = new Intl.DateTimeFormat('id-ID', {
  day: 'numeric',
  month: 'short',
  year: 'numeric'
});

let toastTimer;

const elements = {
  today: document.querySelector('#today-label'),
  totalBudget: document.querySelector('#total-budget'),
  totalRealized: document.querySelector('#total-realized'),
  totalRemaining: document.querySelector('#total-remaining'),
  absorption: document.querySelector('#absorption-rate'),
  budgetCount: document.querySelector('#budget-count'),
  realizationCount: document.querySelector('#realization-count'),
  categoryChart: document.querySelector('#category-chart'),
  allocationRows: document.querySelector('#allocation-rows'),
  activityRows: document.querySelector('#activity-rows'),
  allocationSummary: document.querySelector('#allocation-summary'),
  activitySummary: document.querySelector('#activity-summary'),
  realizationButton: document.querySelector('#open-realization-modal'),
  realizationBudget: document.querySelector('#realization-budget'),
  allocationBalance: document.querySelector('#allocation-balance'),
  yearFilter: document.querySelector('#year-filter'),
  toast: document.querySelector('#toast')
};


/* =========================================================
   UTILITIES
========================================================= */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function safeColor(value) {
  return /^#[\da-f]{6}$/i.test(value || '')
    ? value
    : '#c94e79';
}

function amount(value) {
  return currency.format(Number(value) || 0);
}

function getRealized(budget) {
  return (budget.realisasi || []).reduce(
    (sum, item) => sum + Number(item.jumlah),
    0
  );
}

function getRemaining(budget) {
  return Math.max(
    0,
    Number(budget.jumlah_anggaran) - getRealized(budget)
  );
}

function getVisibleBudgets() {
  return selectedYear === 'all'
    ? state.budgets
    : state.budgets.filter(
        (budget) => String(budget.tahun) === selectedYear
      );
}

function getRealizations() {
  return getVisibleBudgets()
    .flatMap((budget) =>
      (budget.realisasi || []).map((item) => ({
        ...item,
        budget
      }))
    )
    .sort(
      (first, second) =>
        new Date(second.tanggal) - new Date(first.tanggal)
    );
}


/* =========================================================
   SUPABASE REST
========================================================= */

async function supabaseRequest(
  table,
  {
    method = 'GET',
    query = {},
    body,
    prefer
  } = {}
) {
  const params = new URLSearchParams(query);

  const url =
    `${supabaseRestUrl}/${table}` +
    `${params.size ? `?${params}` : ''}`;

  const headers = {
    apikey: supabaseConfig.anonKey,
    Authorization:
      `Bearer ${authSession?.access_token || supabaseConfig.anonKey}`
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (prefer) {
    headers.Prefer = prefer;
  }

  const response = await fetch(url, {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : JSON.stringify(body)
  });

  if (response.status === 204) {
    return null;
  }

  const result = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      result.message ||
      result.error_description ||
      result.error ||
      'Permintaan Supabase gagal.'
    );
  }

  return result;
}


/* =========================================================
   AUTH
========================================================= */

async function supabaseAuthRequest(endpoint, payload) {
  const response = await fetch(
    `${supabaseAuthUrl}/${endpoint}`,
    {
      method: 'POST',
      headers: {
        apikey: supabaseConfig.anonKey,
        Authorization:
          `Bearer ${supabaseConfig.anonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  const result = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      result.msg ||
      result.message ||
      result.error_description ||
      result.error ||
      'Autentikasi Supabase gagal.'
    );
  }

  return result;
}

function saveAuthSession(session) {
  authSession = session;

  if (session) {
    localStorage.setItem(
      'aksara-auth-session',
      JSON.stringify(session)
    );
  } else {
    localStorage.removeItem('aksara-auth-session');
  }
}

async function getCurrentUser() {
  if (!authSession?.access_token) {
    return null;
  }

  const response = await fetch(
    `${supabaseAuthUrl}/user`,
    {
      headers: {
        apikey: supabaseConfig.anonKey,
        Authorization:
          `Bearer ${authSession.access_token}`
      }
    }
  );

  if (response.ok) {
    return response.json();
  }

  if (!authSession.refresh_token) {
    saveAuthSession(null);
    return null;
  }

  const refreshed = await supabaseAuthRequest(
    'token?grant_type=refresh_token',
    {
      refresh_token: authSession.refresh_token
    }
  );

  saveAuthSession(refreshed);

  return refreshed.user;
}


/* =========================================================
   LOAD DATA
========================================================= */

async function loadData() {
  const user = await getCurrentUser();

  const [
    budgets,
    units,
    categories
  ] = await Promise.all([
    supabaseRequest('anggaran', {
      query: {
        select:
          'id,tahun,jumlah_anggaran,catatan,created_at,' +
          'unit_organisasi(id,nama),' +
          'kategori_anggaran(id,nama,warna),' +
          'realisasi(id,tanggal,uraian,jumlah,nomor_bukti)',
        order: 'tahun.desc,created_at.desc'
      }
    }),

    supabaseRequest('unit_organisasi', {
      query: {
        select: 'id,nama',
        order: 'nama.asc'
      }
    }),

    supabaseRequest('kategori_anggaran', {
      query: {
        select: 'id,nama,warna',
        order: 'nama.asc'
      }
    })
  ]);

  state.publicMode = !user;

  state.budgets = budgets || [];

  state.units =
    units?.length
      ? units
      : fallbackUnits;

  state.categories =
    categories?.length
      ? categories
      : fallbackCategories;

  if (user) {
    state.profile = {
      id: user.id,
      nama:
        user.user_metadata?.nama ||
        user.email ||
        'Pengguna AKSARA',
      unit_id: null,
      peran: 'bendahara'
    };

    state.profiles = [state.profile];

    document.body.dataset.auth = 'authenticated';

    const profileName =
      document.querySelector('#profile-name');

    const profileRole =
      document.querySelector('#profile-role');

    if (profileName) {
      profileName.textContent = state.profile.nama;
    }

    if (profileRole) {
      profileRole.textContent =
        'Pengguna terautentikasi';
    }

  } else {

    state.profile = {
      nama: 'Mode publik',
      unit_id: null,
      peran: 'publik'
    };

    state.profiles = [];

    document.body.dataset.auth = 'public';

    const profileName =
      document.querySelector('#profile-name');

    const profileRole =
      document.querySelector('#profile-role');

    if (profileName) {
      profileName.textContent = 'Mode publik';
    }

    if (profileRole) {
      profileRole.textContent =
        'Login tidak aktif';
    }
  }

  const logoutButton =
    document.querySelector('#logout-button');

  const loginButton =
    document.querySelector('#login-button');

  const budgetButton =
    document.querySelector('#open-budget-modal');

  const budgetBottomButton =
    document.querySelector('#open-budget-modal-bottom');

  if (logoutButton) {
    logoutButton.hidden = !user;
  }

  if (loginButton) {
    loginButton.hidden = Boolean(user);
  }

  if (budgetButton) {
    budgetButton.hidden = !canManageBudget();
  }

  if (budgetBottomButton) {
    budgetBottomButton.hidden =
      !canManageBudget();
  }

  if (elements.realizationButton) {
    elements.realizationButton.hidden =
      !canManageBudget();
  }

  populateYearFilter();

  const statusChip =
    document.querySelector('.status-chip');

  if (statusChip) {
    statusChip.innerHTML =
      '<span class="status-dot"></span> Terhubung';
  }

  render();
}


/* =========================================================
   ACCESS
========================================================= */

function isFinanceRole() {
  return (
    !state.publicMode &&
    ['admin', 'bendahara'].includes(
      state.profile?.peran
    )
  );
}

function canManageBudget() {
  return (
    state.publicMode ||
    Boolean(state.profile?.id)
  );
}


/* =========================================================
   DASHBOARD
========================================================= */

function renderMetrics() {
  const budgets = getVisibleBudgets();

  const totalBudget =
    budgets.reduce(
      (sum, budget) =>
        sum + Number(budget.jumlah_anggaran),
      0
    );

  const totalRealized =
    budgets.reduce(
      (sum, budget) =>
        sum + getRealized(budget),
      0
    );

  const totalRemaining =
    Math.max(
      0,
      totalBudget - totalRealized
    );

  const realizationCount =
    getRealizations().length;

  const rate =
    totalBudget
      ? Math.round(
          (totalRealized / totalBudget) * 100
        )
      : 0;

  elements.totalBudget.textContent =
    amount(totalBudget);

  elements.totalRealized.textContent =
    amount(totalRealized);

  elements.totalRemaining.textContent =
    amount(totalRemaining);

  elements.absorption.textContent =
    `${rate}%`;

  elements.budgetCount.textContent =
    `${budgets.length} alokasi anggaran`;

  elements.realizationCount.textContent =
    `${realizationCount} transaksi tercatat`;

  document.querySelector(
    '#current-year'
  ).textContent =
    selectedYear === 'all'
      ? 'Semua tahun'
      : selectedYear;

  document.querySelector(
    '#ring-rate'
  ).textContent = `${rate}%`;

  document.querySelector(
    '#ring-chart'
  ).style.background =
    `conic-gradient(#d65f89 ${
      Math.min(rate, 100) * 3.6
    }deg, #f2e9ed 0deg)`;

  document.querySelector(
    '#ring-chart'
  ).setAttribute(
    'aria-label',
    `Serapan anggaran ${rate} persen`
  );

  document.querySelector(
    '#insight-realized'
  ).textContent =
    amount(totalRealized);

  document.querySelector(
    '#insight-remaining'
  ).textContent =
    amount(totalRemaining);

  document.querySelector(
    '#insight-caption'
  ).textContent =
    budgets.length
      ? `${realizationCount} transaksi tercatat pada ${budgets.length} alokasi.`
      : 'Data akan tampil setelah anggaran ditambahkan.';
}

function renderCategoryChart() {
  const groups = new Map();

  getVisibleBudgets().forEach((budget) => {
    const category =
      budget.kategori_anggaran || {
        id: 'other',
        nama: 'Lainnya',
        warna: '#c94e79'
      };

    const group =
      groups.get(category.id) || {
        ...category,
        allocated: 0,
        realized: 0
      };

    group.allocated +=
      Number(budget.jumlah_anggaran);

    group.realized +=
      getRealized(budget);

    groups.set(category.id, group);
  });

  const categories =
    [...groups.values()].sort(
      (first, second) =>
        second.allocated - first.allocated
    );

  const total =
    categories.reduce(
      (sum, category) =>
        sum + category.allocated,
      0
    );

  if (!categories.length) {
    elements.categoryChart.innerHTML =
      '<p class="category-empty">Belum ada alokasi. Tambahkan anggaran untuk melihat sebaran dana.</p>';

    return;
  }

  elements.categoryChart.innerHTML =
    categories.map((category) => {
      const percentage =
        total
          ? Math.round(
              (category.allocated / total) * 100
            )
          : 0;

      const color =
        safeColor(category.warna);

      return `
        <div class="category-row">
          <div class="category-row-top">
            <span class="category-name">
              <i
                class="category-swatch"
                style="background:${color}"
              ></i>

              ${escapeHtml(category.nama)}

              <span class="category-meta">
                ${percentage}%
              </span>
            </span>

            <span class="category-amount">
              ${amount(category.allocated)}
            </span>
          </div>

          <div class="bar-track">
            <div
              class="bar-fill"
              style="width:${percentage}%;background:${color}"
            ></div>
          </div>
        </div>
      `;
    }).join('');
}


/* =========================================================
   ALLOCATION TABLE
========================================================= */

function renderAllocations() {
  const searchInput =
    document.querySelector(
      '#allocation-search'
    );

  const query =
    searchInput?.value
      ?.trim()
      .toLocaleLowerCase('id-ID') || '';

  const visibleBudgets =
    getVisibleBudgets();

  const budgets =
    [...visibleBudgets].filter((budget) => {
      const searchable = [
        budget.kategori_anggaran?.nama,
        budget.unit_organisasi?.nama,
        budget.tahun,
        budget.catatan
      ]
        .join(' ')
        .toLocaleLowerCase('id-ID');

      return searchable.includes(query);
    });

  elements.allocationSummary.textContent =
    `${budgets.length} dari ${visibleBudgets.length} alokasi`;

  if (!budgets.length) {
    elements.allocationRows.innerHTML = `
      <tr>
        <td
          class="empty-cell"
          colspan="7"
        >
          ${
            visibleBudgets.length
              ? 'Tidak ada alokasi yang cocok dengan pencarian.'
              : 'Belum ada alokasi anggaran. Mulai dengan menambahkan anggaran pertama.'
          }
        </td>
      </tr>
    `;

    return;
  }

  elements.allocationRows.innerHTML =
    budgets.map((budget) => {
      const category =
        budget.kategori_anggaran || {
          nama: 'Kategori',
          warna: '#c94e79'
        };

      const allocated =
        Number(budget.jumlah_anggaran);

      const realized =
        getRealized(budget);

      const percentage =
        allocated
          ? Math.round(
              (realized / allocated) * 100
            )
          : 0;

      return `
        <tr>
          <td>
            <span class="table-category">
              <i
                class="category-swatch"
                style="background:${safeColor(category.warna)}"
              ></i>

              ${escapeHtml(category.nama)}
            </span>

            ${
              budget.catatan
                ? `
                  <span class="secondary-cell">
                    ${escapeHtml(budget.catatan)}
                  </span>
                `
                : ''
            }
          </td>

          <td>
            ${escapeHtml(
              budget.unit_organisasi?.nama || '-'
            )}
          </td>

          <td>
            ${escapeHtml(budget.tahun)}
          </td>

          <td class="money-cell">
            ${amount(allocated)}
          </td>

          <td>
            ${amount(realized)}
          </td>

          <td class="progress-cell">
            <div class="progress-label">
              <span>
                ${amount(realized)}
              </span>

              <strong>
                ${percentage}%
              </strong>
            </div>

            <div class="progress-mini">
              <span
                style="width:${Math.min(
                  percentage,
                  100
                )}%"
              ></span>
            </div>
          </td>

          <td>
            ${
              canManageBudget()
                ? `
                  <button
                    class="delete-button"
                    type="button"
                    data-realize-budget="${budget.id}"
                    aria-label="Catat realisasi untuk ${escapeHtml(category.nama)}"
                    title="Catat realisasi"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d="M12 5v14M5 12h14"/>
                    </svg>
                  </button>
                `
                : `
                  <span class="secondary-cell">
                    Terbatas
                  </span>
                `
            }
          </td>
        </tr>
      `;
    }).join('');
}


/* =========================================================
   REALIZATION TABLE
========================================================= */

function renderActivity() {
  const realizations =
    getRealizations();

  const recent =
    realizations.slice(0, 8);

  elements.activitySummary.textContent =
    `${realizations.length} transaksi tercatat`;

  if (!recent.length) {
    elements.activityRows.innerHTML =
      `
        <tr>
          <td
            class="empty-cell"
            colspan="6"
          >
            Belum ada realisasi. Catat pengeluaran untuk mulai memperbarui laporan.
          </td>
        </tr>
      `;

    return;
  }

  elements.activityRows.innerHTML =
    recent.map((item) => `
      <tr>
        <td class="date-cell">
          ${dateFormat.format(
            new Date(
              `${item.tanggal}T00:00:00`
            )
          )}
        </td>

        <td>
          <span class="activity-description">
            ${escapeHtml(item.uraian)}
          </span>
        </td>

        <td>
          <span class="activity-allocation">
            ${escapeHtml(
              item.budget.kategori_anggaran?.nama ||
              'Kategori'
            )}
            ·
            ${escapeHtml(
              item.budget.unit_organisasi?.nama ||
              ''
            )}
          </span>
        </td>

        <td>
          ${
            item.nomor_bukti
              ? `
                <span class="receipt-tag">
                  ${escapeHtml(item.nomor_bukti)}
                </span>
              `
              : `
                <span class="secondary-cell">
                  -
                </span>
              `
          }
        </td>

        <td class="money-cell">
          ${amount(item.jumlah)}
        </td>

        <td>
          ${
            isFinanceRole()
              ? `
                <button
                  class="delete-button"
                  type="button"
                  data-delete-realization="${item.id}"
                  aria-label="Hapus realisasi ${escapeHtml(item.uraian)}"
                  title="Hapus transaksi"
                >
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d="M4 7h16M9 7V4h6v3m3 0-.8 13H6.8L6 7m3.5 3v6m5-6v6"/>
                  </svg>
                </button>
              `
              : `
                <span class="secondary-cell">
                  Terkunci
                </span>
              `
          }
        </td>
      </tr>
    `).join('');
}


/* =========================================================
   FORM OPTIONS
========================================================= */

function populateOptions() {
  const unitSelect =
    document.querySelector('#budget-unit');

  const categorySelect =
    document.querySelector('#budget-category');

  const budgetSelect =
    elements.realizationBudget;

  if (!unitSelect || !categorySelect) {
    return;
  }

  unitSelect.innerHTML =
    '<option value="">Pilih unit</option>' +
    state.units
      .map(
        (unit) =>
          `<option value="${unit.id}">
            ${escapeHtml(unit.nama)}
          </option>`
      )
      .join('');

  categorySelect.innerHTML =
    '<option value="">Pilih kategori</option>' +
    state.categories
      .map(
        (category) =>
          `<option value="${category.id}">
            ${escapeHtml(category.nama)}
          </option>`
      )
      .join('');

  const availableBudgets =
    getVisibleBudgets()
      .filter(
        (budget) =>
          getRemaining(budget) > 0
      );

  if (budgetSelect) {
    budgetSelect.innerHTML =
      '<option value="">Pilih alokasi</option>' +
      availableBudgets
        .map(
          (budget) =>
            `<option value="${budget.id}">
              ${escapeHtml(
                budget.kategori_anggaran?.nama ||
                'Kategori'
              )}
              ·
              ${escapeHtml(
                budget.unit_organisasi?.nama ||
                ''
              )}
              ·
              ${budget.tahun}
            </option>`
        )
        .join('');
  }

  if (elements.realizationButton) {
    elements.realizationButton.disabled =
      !availableBudgets.length;

    elements.realizationButton.hidden =
      !canManageBudget() ||
      document.body.dataset.view !== 'activity';
  }

  const bottomButton =
    document.querySelector(
      '#open-budget-modal-bottom'
    );

  if (bottomButton) {
    bottomButton.hidden =
      !canManageBudget();
  }
}

function render() {
  renderMetrics();
  renderCategoryChart();
  renderAllocations();
  renderActivity();
  populateOptions();
}

function populateYearFilter() {
  const years = new Set([
    String(new Date().getFullYear()),
    ...state.budgets.map(
      (budget) => String(budget.tahun)
    )
  ]);

  const options =
    [...years].sort(
      (first, second) =>
        Number(second) - Number(first)
    );

  elements.yearFilter.innerHTML =
    '<option value="all">Semua tahun</option>' +
    options
      .map(
        (year) =>
          `<option value="${year}">
            ${year}
          </option>`
      )
      .join('');

  if (
    selectedYear !== 'all' &&
    !years.has(selectedYear)
  ) {
    selectedYear =
      String(new Date().getFullYear());
  }

  elements.yearFilter.value =
    selectedYear;
}


/* =========================================================
   TOAST / MODAL
========================================================= */

function showToast(
  message,
  isError = false
) {
  clearTimeout(toastTimer);

  elements.toast.textContent =
    message;

  elements.toast.classList.toggle(
    'is-error',
    isError
  );

  elements.toast.classList.add(
    'is-visible'
  );

  toastTimer = setTimeout(
    () =>
      elements.toast.classList.remove(
        'is-visible'
      ),
    3400
  );
}

function openDialog(id) {
  const dialog =
    document.getElementById(id);

  setFormError(
    id === 'budget-modal'
      ? 'budget-error'
      : 'realization-error'
  );

  if (id === 'budget-modal') {
    document.querySelector(
      '#budget-year'
    ).value =
      String(new Date().getFullYear());
  }

  if (id === 'realization-modal') {
    const date = new Date();

    document.querySelector(
      '#realization-form [name="tanggal"]'
    ).value = [
      date.getFullYear(),
      String(
        date.getMonth() + 1
      ).padStart(2, '0'),
      String(
        date.getDate()
      ).padStart(2, '0')
    ].join('-');

    updateAllocationBalance();
  }

  dialog.showModal();
}

function updateAllocationBalance() {
  const budget =
    state.budgets.find(
      (item) =>
        String(item.id) ===
        elements.realizationBudget.value
    );

  if (!budget) {
    elements.allocationBalance.hidden =
      true;

    return;
  }

  elements.allocationBalance.hidden =
    false;

  elements.allocationBalance.textContent =
    `Sisa alokasi ini: ${amount(
      getRemaining(budget)
    )} dari ${amount(
      budget.jumlah_anggaran
    )}`;

  document.querySelector(
    '#realization-form [name="jumlah"]'
  ).max =
    String(getRemaining(budget));
}

function closeDialog(id) {
  document
    .getElementById(id)
    .close();
}

function setFormError(
  id,
  message = ''
) {
  const element =
    document.getElementById(id);

  if (element) {
    element.textContent =
      message;
  }
}


/* =========================================================
   SAVE BUDGET
========================================================= */

async function resolveOptionId(
  table,
  value
) {
  const numericId =
    Number(value);

  if (
    Number.isInteger(numericId) &&
    numericId > 0
  ) {
    return numericId;
  }

  const name =
    String(value || '').trim();

  if (!name) {
    throw new Error(
      'Pilihan unit/kategori belum dipilih.'
    );
  }

  const existing =
    await supabaseRequest(
      table,
      {
        query: {
          select: 'id',
          nama: `eq.${name}`,
          limit: '1'
        }
      }
    );

  if (existing.length) {
    return existing[0].id;
  }

  const created =
    await supabaseRequest(
      table,
      {
        method: 'POST',
        query: {
          select: 'id'
        },
        body: {
          nama: name
        },
        prefer: 'return=representation'
      }
    );

  if (!created.length) {
    throw new Error(
      `Gagal menyimpan pilihan ${name}.`
    );
  }

  return created[0].id;
}

async function saveBudget(
  payload
) {
  const [
    unitId,
    categoryId
  ] = await Promise.all([
    resolveOptionId(
      'unit_organisasi',
      payload.unit_id
    ),

    resolveOptionId(
      'kategori_anggaran',
      payload.kategori_id
    )
  ]);

  await supabaseRequest(
    'anggaran',
    {
      method: 'POST',

      body: {
        unit_id: unitId,
        kategori_id: categoryId,
        tahun: Number(payload.tahun),
        jumlah_anggaran:
          Number(
            payload.jumlah_anggaran
          ),
        catatan:
          payload.catatan.trim() ||
          null
      },

      prefer:
        'return=representation'
    }
  );
}


/* =========================================================
   SAVE REALIZATION
========================================================= */

async function saveRealization(
  payload
) {
  const budget =
    state.budgets.find(
      (item) =>
        String(item.id) ===
        String(payload.anggaran_id)
    );

  if (!budget) {
    throw new Error(
      'Alokasi anggaran tidak ditemukan.'
    );
  }

  if (
    Number(payload.jumlah) >
    getRemaining(budget)
  ) {
    throw new Error(
      'Realisasi melebihi sisa anggaran pada alokasi ini.'
    );
  }

  await supabaseRequest(
    'realisasi',
    {
      method: 'POST',

      body: {
        anggaran_id:
          Number(payload.anggaran_id),

        tanggal:
          payload.tanggal,

        uraian:
          payload.uraian.trim(),

        jumlah:
          Number(payload.jumlah),

        nomor_bukti:
          payload.nomor_bukti.trim() ||
          null
      },

      prefer:
        'return=representation'
    }
  );
}


/* =========================================================
   GENERIC FORM SUBMIT
========================================================= */

async function submitForm(
  event,
  action,
  modalId,
  errorId,
  successMessage
) {
  event.preventDefault();

  const form =
    event.currentTarget;

  const submitButton =
    form.querySelector(
      '[type="submit"]'
    );

  const payload =
    Object.fromEntries(
      new FormData(form).entries()
    );

  submitButton.disabled =
    true;

  setFormError(errorId);

  try {
    if (action === 'budget') {
      await saveBudget(payload);

      selectedYear =
        String(payload.tahun);
    } else {
      await saveRealization(
        payload
      );
    }

    form.reset();

    closeDialog(modalId);

    await loadData();

    showToast(
      successMessage
    );

  } catch (error) {
    setFormError(
      errorId,
      error.message
    );

  } finally {
    submitButton.disabled =
      false;
  }
}


/* =========================================================
   DATE
========================================================= */

document.querySelector(
  '#today-label'
).textContent =
  new Intl.DateTimeFormat(
    'id-ID',
    {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }
  ).format(new Date());


/* =========================================================
   AUTH UI
========================================================= */

function setAuthMode(mode) {
  authMode = mode;

  const isSignup =
    mode === 'signup';

  document.querySelector(
    '#signup-fields'
  ).hidden = !isSignup;

  document.querySelector(
    '#auth-title'
  ).textContent =
    isSignup
      ? 'Daftar sebagai anggota'
      : 'Masuk ke AKSARA';

  document.querySelector(
    '#auth-mode-label'
  ).textContent =
    isSignup
      ? 'AKUN ANGGOTA'
      : 'RUANG KERJA ORGANISASI';

  document.querySelector(
    '#auth-description'
  ).textContent =
    isSignup
      ? 'Pilih divisi Anda untuk memulai.'
      : 'Gunakan akun organisasi Anda untuk melanjutkan.';

  document.querySelector(
    '#auth-submit'
  ).textContent =
    isSignup
      ? 'Buat akun'
      : 'Masuk';

  document.querySelector(
    '#auth-switch'
  ).textContent =
    isSignup
      ? 'Sudah punya akun? Masuk'
      : 'Belum punya akun? Daftar sebagai anggota';

  document.querySelector(
    '#auth-form [name="nama"]'
  ).required = isSignup;

  document.querySelector(
    '#auth-form [name="unit_nama"]'
  ).required = isSignup;

  document.querySelector(
    '#auth-error'
  ).textContent = '';
}

document.querySelector(
  '#auth-switch'
).addEventListener(
  'click',
  () =>
    setAuthMode(
      authMode === 'signup'
        ? 'signin'
        : 'signup'
    )
);

document.querySelector(
  '#login-button'
).addEventListener(
  'click',
  () => {
    document.body.dataset.auth =
      'login';

    setAuthMode('signin');
  }
);

document.querySelector(
  '#auth-skip'
).addEventListener(
  'click',
  () => {
    saveAuthSession(null);

    document.body.dataset.auth =
      'public';

    loadData().catch(
      (error) =>
        showToast(
          error.message,
          true
        )
    );
  }
);

document.querySelector(
  '#auth-form'
).addEventListener(
  'submit',
  async (event) => {
    event.preventDefault();

    const form =
      event.currentTarget;

    const submit =
      document.querySelector(
        '#auth-submit'
      );

    const data =
      Object.fromEntries(
        new FormData(form).entries()
      );

    submit.disabled = true;

    document.querySelector(
      '#auth-error'
    ).textContent = '';

    try {
      if (authMode === 'signup') {

        await supabaseAuthRequest(
          'signup',
          {
            email: data.email,
            password: data.password,

            data: {
              nama:
                data.nama.trim(),

              unit_nama:
                data.unit_nama
            }
          }
        );

        setAuthMode('signin');

        document.querySelector(
          '#auth-error'
        ).textContent =
          'Akun dibuat. Cek email untuk konfirmasi jika diminta, lalu masuk.';

      } else {

        const session =
          await supabaseAuthRequest(
            'token?grant_type=password',
            {
              email: data.email,
              password: data.password
            }
          );

        saveAuthSession(session);

        await loadData();
      }

    } catch (error) {

      document.querySelector(
        '#auth-error'
      ).textContent =
        error.message;

    } finally {

      submit.disabled = false;
    }
  }
);

document.querySelector(
  '#logout-button'
).addEventListener(
  'click',
  () => {
    saveAuthSession(null);

    state.profile = null;
    state.publicMode = true;

    document.body.dataset.auth =
      'public';

    setAuthMode('signin');

    loadData().catch(
      (error) =>
        showToast(
          error.message,
          true
        )
    );
  }
);


/* =========================================================
   YEAR
========================================================= */

const yearSelect =
  document.querySelector(
    '#budget-year'
  );

const currentYear =
  new Date().getFullYear();

yearSelect.innerHTML =
  [
    currentYear - 1,
    currentYear,
    currentYear + 1
  ]
    .map(
      (year) =>
        `<option value="${year}">
          ${year}
        </option>`
    )
    .join('');


/* =========================================================
   MODALS
========================================================= */

document.querySelector('#open-budget-modal').addEventListener(
  'click',
  () => {
    openDialog('budget-modal');
  }
);

document.querySelector(
  '#open-budget-modal-bottom'
).addEventListener(
  'click',
  () =>
    openDialog(
      'budget-modal'
    )
);

elements.realizationButton.addEventListener(
  'click',
  () =>
    openDialog(
      'realization-modal'
    )
);

document.querySelectorAll(
  '[data-close]'
).forEach(
  (button) =>
    button.addEventListener(
      'click',
      () =>
        closeDialog(
          button.dataset.close
        )
    )
);


/* =========================================================
   BUDGET FORM
========================================================= */

document.querySelector(
  '#budget-form'
).addEventListener(
  'submit',
  (event) =>
    submitForm(
      event,
      'budget',
      'budget-modal',
      'budget-error',
      'Anggaran berhasil ditambahkan.'
    )
);


/* =========================================================
   REALIZATION FORM
========================================================= */

document.querySelector(
  '#realization-form'
).addEventListener(
  'submit',
  (event) =>
    submitForm(
      event,
      'realization',
      'realization-modal',
      'realization-error',
      'Realisasi berhasil dicatat.'
    )
);

elements.realizationBudget.addEventListener(
  'change',
  updateAllocationBalance
);


/* =========================================================
   SEARCH / FILTER
========================================================= */

document.querySelector(
  '#allocation-search'
).addEventListener(
  'input',
  renderAllocations
);

elements.yearFilter.addEventListener(
  'change',
  () => {
    selectedYear =
      elements.yearFilter.value;

    render();
  }
);


/* =========================================================
   CATAT REALISASI DARI TABEL ANGGARAN
========================================================= */

document.querySelector(
  '#allocation-rows'
).addEventListener(
  'click',
  (event) => {
    const button =
      event.target.closest(
        '[data-realize-budget]'
      );

    if (!button) {
      return;
    }

    elements.realizationBudget.value =
      button.dataset.realizeBudget;

    openDialog(
      'realization-modal'
    );
  }
);


/* =========================================================
   DELETE REALIZATION
========================================================= */

document.querySelector(
  '#activity-rows'
).addEventListener(
  'click',
  async (event) => {
    const button =
      event.target.closest(
        '[data-delete-realization]'
      );

    if (
      !button ||
      !window.confirm(
        'Hapus transaksi realisasi ini?'
      )
    ) {
      return;
    }

    button.disabled = true;

    try {

      await supabaseRequest(
        'realisasi',
        {
          method: 'DELETE',

          query: {
            id:
              `eq.${button.dataset.deleteRealization}`
          }
        }
      );

      await loadData();

      showToast(
        'Realisasi berhasil dihapus.'
      );

    } catch (error) {

      button.disabled = false;

      showToast(
        error.message,
        true
      );
    }
  }
);


/* =========================================================
   PAGE NAVIGATION
========================================================= */

const viewContent = {
  dashboard: {
    breadcrumb:
      'Dashboard Anggaran',

    eyebrow:
      'PENGELOLAAN KEUANGAN ORGANISASI',

    title:
      'Dashboard Anggaran',

    subtitle:
      'Pantau pagu, realisasi, dan saldo keuangan organisasi.'
  },

  allocations: {
    breadcrumb:
      'Alokasi Anggaran',

    eyebrow:
      'PERENCANAAN DAN PENGENDALIAN',

    title:
      'Alokasi Anggaran',

    subtitle:
      'Kelola pagu dan tinjau penggunaan dana setiap divisi.'
  },

  activity: {
    breadcrumb:
      'Realisasi',

    eyebrow:
      'PENCATATAN TRANSAKSI',

    title:
      'Realisasi Anggaran',

    subtitle:
      'Tinjau transaksi dan catat penggunaan dana.'
  }
};

document.querySelectorAll(
  '.main-nav [data-view]'
).forEach(
  (button) =>
    button.addEventListener(
      'click',
      () => {
        const view =
          button.dataset.view;

        const content =
          viewContent[view];

        if (!content) {
          return;
        }

        document.body.dataset.view =
          view;

        document.querySelectorAll(
          '.main-nav [data-view]'
        ).forEach(
          (item) => {
            const active =
              item === button;

            item.classList.toggle(
              'is-active',
              active
            );

            if (active) {
              item.setAttribute(
                'aria-current',
                'page'
              );
            } else {
              item.removeAttribute(
                'aria-current'
              );
            }
          }
        );

        document.querySelector(
          '#breadcrumb-current'
        ).textContent =
          content.breadcrumb;

        document.querySelector(
          '#page-eyebrow'
        ).textContent =
          content.eyebrow;

        document.querySelector(
          '#page-title'
        ).textContent =
          content.title;

        document.querySelector(
          '#page-subtitle'
        ).textContent =
          content.subtitle;

        const primaryAction = document.querySelector(
            '#open-budget-modal'
          );

        const realizationButton = document.querySelector(
             '#open-realization-modal'
          );
        if (primaryAction) {
          primaryAction.hidden =
            !canManageBudget() || view === 'activity';
        }

        if (elements.realizationButton) {
          elements.realizationButton.hidden =
            !canManageBudget() || view !== 'activity';
        }

        document.querySelector(
          '#page-action-label'
        ).textContent = 'Tambah anggaran';
   

        window.scrollTo({
          top: 0,
          behavior: 'smooth'
        });
      }
    )
);


/* =========================================================
   START
========================================================= */

loadData().catch(
  (error) => {
    const connectionMessage =
      `Supabase belum dapat diakses: ${error.message}. Periksa migrasi workflow, session, dan konfigurasi Supabase.`;

    if (!authSession?.access_token) {
      document.body.dataset.auth =
        'public';
    }

    const statusChip =
      document.querySelector(
        '.status-chip'
      );

    if (statusChip) {
      statusChip.innerHTML =
        '<span class="status-dot" style="background:#c86459"></span> Tidak terhubung';
    }

    elements.categoryChart.textContent =
      connectionMessage;

    elements.categoryChart.classList.add(
      'category-empty'
    );

    elements.allocationRows.innerHTML =
      `
        <tr>
          <td
            class="empty-cell"
            colspan="7"
          >
            ${connectionMessage}
          </td>
        </tr>
      `;

    elements.activityRows.innerHTML =
      `
        <tr>
          <td
            class="empty-cell"
            colspan="6"
          >
            ${connectionMessage}
          </td>
        </tr>
      `;

    populateOptions();

    showToast(
      `Supabase belum tersambung: ${error.message}`,
      true
    );
  }
);