(function () {
  'use strict';

  const pageSize = 20;
  const form = document.getElementById('productsFilters');
  const search = document.getElementById('productsSearch');
  const category = document.getElementById('productsCategory');
  const minimumPrice = document.getElementById('productsMinPrice');
  const maximumPrice = document.getElementById('productsMaxPrice');
  const sort = document.getElementById('productsSort');
  const categoryStatus = document.getElementById('productsCategoryStatus');
  const results = document.getElementById('productsResults');
  const grid = document.getElementById('productsGrid');
  const feedback = document.getElementById('productsFeedback');
  const resultCount = document.getElementById('productsResultCount');
  const previous = document.getElementById('productsPrevious');
  const next = document.getElementById('productsNext');
  const pageLabel = document.getElementById('productsPageLabel');
  const params = new URLSearchParams(window.location.search);
  const state = {
    q: (params.get('q') || '').slice(0, 100),
    category: params.get('category') || '',
    minPrice: params.get('minPrice') || '',
    maxPrice: params.get('maxPrice') || '',
    sort: params.get('sort') || 'newest',
    offset: parseOffset(params.get('offset')),
    total: 0
  };
  search.value = state.q;
  minimumPrice.value = state.minPrice;
  maximumPrice.value = state.maxPrice;
  if (Array.from(sort.options).some(function (option) { return option.value === state.sort; })) sort.value = state.sort;
  else state.sort = 'newest';

  function parseOffset(value) {
    if (!value || !/^\d+$/.test(value)) return 0;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed <= 100000 ? parsed : 0;
  }

  async function request(url) {
    const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error('The server returned an unreadable response.');
    }
    if (!response.ok) throw new Error(payload && payload.message ? payload.message : 'The request could not be completed.');
    return payload;
  }

  function setFeedback(message, kind, retry) {
    feedback.replaceChildren();
    feedback.hidden = !message;
    feedback.className = 'products-feedback' + (kind ? ' ' + kind : '');
    if (!message) return;
    const text = document.createElement('span');
    text.textContent = message;
    feedback.appendChild(text);
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-secondary';
      button.textContent = 'Retry';
      button.addEventListener('click', loadProducts);
      feedback.appendChild(button);
    }
  }

  function safeImageUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value, window.location.origin);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.origin === window.location.origin)) return null;
      return url.href;
    } catch (error) {
      return null;
    }
  }

  function appendIfPresent(parent, product, key, className, formatter) {
    if (!Object.prototype.hasOwnProperty.call(product, key) || product[key] === null || product[key] === '') return;
    const element = document.createElement('p');
    if (className) element.className = className;
    element.textContent = formatter ? formatter(product[key]) : String(product[key]);
    parent.appendChild(element);
  }

  function makeProductCard(product) {
    const card = document.createElement('article');
    card.className = 'market-product-card';
    const imageUrl = safeImageUrl(product.image_url);
    if (imageUrl) {
      const image = document.createElement('img');
      image.src = imageUrl;
      image.alt = typeof product.product_name === 'string' ? product.product_name : 'Product listing';
      image.loading = 'lazy';
      image.addEventListener('error', function () {
        const fallback = document.createElement('div');
        fallback.className = 'market-product-image-placeholder';
        fallback.textContent = 'Image unavailable';
        image.replaceWith(fallback);
      }, { once: true });
      card.appendChild(image);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'market-product-image-placeholder';
      placeholder.textContent = 'Image not provided';
      card.appendChild(placeholder);
    }
    const content = document.createElement('div');
    content.className = 'market-product-card-content';
    appendIfPresent(content, product, 'category', 'market-product-category');
    const title = document.createElement('h3');
    title.textContent = typeof product.product_name === 'string' ? product.product_name : 'Product listing';
    const id = Number(product.product_id);
    if (Number.isSafeInteger(id) && id > 0) {
      const link = document.createElement('a');
      link.href = '/product-detail.html?id=' + encodeURIComponent(String(id));
      link.appendChild(title);
      content.appendChild(link);
    } else {
      content.appendChild(title);
    }
    appendIfPresent(content, product, 'price_kina', 'market-product-price', function (value) {
      return 'K ' + String(value) + (product.price_unit ? ' / ' + product.price_unit : '');
    });
    appendIfPresent(content, product, 'item_condition', 'market-product-condition', function (value) {
      return ({ new: 'New', used: 'Used', refurbished: 'Refurbished' })[value] || String(value);
    });
    appendIfPresent(content, product, 'stock_quantity', 'market-product-stock', function (value) {
      const quantity = Number(value);
      return Number.isFinite(quantity) ? (quantity > 0 ? 'In stock' : 'Out of stock') : String(value);
    });
    appendIfPresent(content, product, 'business_name', 'market-product-vendor');
    appendIfPresent(content, product, 'province', 'market-product-location');
    appendIfPresent(content, product, 'delivery_type', 'market-product-delivery', function (value) {
      return ({ delivery: 'Delivery available', pickup: 'Pickup available', both: 'Delivery or pickup' })[value] || 'Delivery options vary';
    });
    if (Number.isSafeInteger(id) && id > 0) {
      const view = document.createElement('a');
      view.className = 'market-product-view';
      view.href = '/product-detail.html?id=' + encodeURIComponent(String(id));
      view.textContent = 'View full details';
      content.appendChild(view);
    }
    card.appendChild(content);
    return card;
  }

  async function loadCategories() {
    categoryStatus.className = 'products-status';
    categoryStatus.textContent = 'Loading categories...';
    try {
      const payload = await request('/api/products/categories');
      if (!payload || !Array.isArray(payload.categories)) throw new Error('The categories response was invalid.');
      const categories = payload.categories.filter(function (value) { return typeof value === 'string' && value.trim(); });
      categories.forEach(function (value) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        category.appendChild(option);
      });
      category.value = state.category;
      if (category.value !== state.category) category.value = '';
      minimumPrice.value = state.minPrice;
      maximumPrice.value = state.maxPrice;
      sort.value = state.sort;
      categoryStatus.textContent = categories.length ? '' : 'No product categories are currently available.';
    } catch (error) {
      categoryStatus.classList.add('error');
      categoryStatus.textContent = 'Categories could not be loaded: ' + error.message + ' ';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-secondary';
      retry.textContent = 'Retry categories';
      retry.addEventListener('click', loadCategories);
      categoryStatus.appendChild(retry);
    }
  }

  function updatePaging() {
    const pageNumber = Math.floor(state.offset / pageSize) + 1;
    const pageCount = Math.max(1, Math.ceil(state.total / pageSize));
    pageLabel.textContent = 'Page ' + pageNumber + ' of ' + pageCount;
    previous.disabled = state.offset <= 0;
    next.disabled = state.offset + pageSize >= state.total;
  }

  async function loadProducts() {
    results.setAttribute('aria-busy', 'true');
    grid.replaceChildren();
    resultCount.textContent = '';
    setFeedback('Loading product listings...', '', false);
    const query = new URLSearchParams({ limit: String(pageSize), offset: String(state.offset) });
    if (state.q) query.set('q', state.q);
    if (state.category) query.set('category', state.category);
    if (state.minPrice) query.set('minPrice', state.minPrice);
    if (state.maxPrice) query.set('maxPrice', state.maxPrice);
    if (state.sort !== 'newest') query.set('sort', state.sort);
    try {
      const payload = await request('/api/products?' + query.toString());
      if (!payload || !Array.isArray(payload.products) || !Number.isFinite(Number(payload.total))) {
        throw new Error('The products response was invalid.');
      }
      state.total = Number(payload.total);
      payload.products.forEach(function (product) {
        grid.appendChild(makeProductCard(product));
      });
      resultCount.textContent = state.total + (state.total === 1 ? ' listing' : ' listings');
      if (!payload.products.length) {
        setFeedback('No product listings match these filters.', '', false);
      } else {
        setFeedback('', '', false);
      }
      updatePaging();
    } catch (error) {
      state.total = 0;
      updatePaging();
      setFeedback('Product listings could not be loaded: ' + error.message, 'error', true);
    } finally {
      results.setAttribute('aria-busy', 'false');
    }
  }

  function navigateWithFilters(offset) {
    const query = new URLSearchParams();
    const q = search.value.trim().slice(0, 100);
    const minPrice = minimumPrice.value.trim();
    const maxPrice = maximumPrice.value.trim();
    if (q) query.set('q', q);
    if (category.value) query.set('category', category.value);
    if (minPrice) query.set('minPrice', minPrice);
    if (maxPrice) query.set('maxPrice', maxPrice);
    if (sort.value && sort.value !== 'newest') query.set('sort', sort.value);
    if (offset > 0) query.set('offset', String(offset));
    window.location.assign('/products' + (query.size ? '?' + query.toString() : ''));
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    navigateWithFilters(0);
  });
  previous.addEventListener('click', function () {
    navigateWithFilters(Math.max(0, state.offset - pageSize));
  });
  next.addEventListener('click', function () {
    if (state.offset + pageSize < state.total) navigateWithFilters(state.offset + pageSize);
  });

  loadCategories();
  loadProducts();
}());
