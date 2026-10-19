'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readApiJson } from '@/lib/http-json';

export interface PublicRegistryExpert {
  id: string;
  key: string;
  catalogKey: string;
  name: string;
  nickname: string;
  description: string;
  image: string;
  visible: boolean;
  order: number;
  freeBoard: string;
}

export type PublicRegistryProduct = Record<string, unknown> & {
  id: string;
  product_name: string;
  expert_id: string;
  expert_key: string;
  expert_name: string;
  profile_image: string;
  options: Array<Record<string, unknown> & {
    id: string;
    base_period: number;
    bonus_period: number;
    price: number;
  }>;
  display?: boolean;
};

export interface PublicRegistry {
  experts: PublicRegistryExpert[];
  products: PublicRegistryProduct[];
}

const emptyRegistry: PublicRegistry = { experts: [], products: [] };
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const number = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function expert(value: unknown): PublicRegistryExpert | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id);
  const key = text(row.key);
  if (!id || !key) return null;
  return {
    id,
    key,
    catalogKey: text(row.catalogKey) || key,
    name: text(row.name) || text(row.nickname) || key,
    nickname: text(row.nickname),
    description: text(row.description),
    image: text(row.image),
    visible: row.visible !== false,
    order: number(row.order),
    freeBoard: text(row.freeBoard) || key,
  };
}

function product(value: unknown, experts: PublicRegistryExpert[]): PublicRegistryProduct | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id) || text(row.productId);
  const expertKey = text(row.expert) || text(row.expertKey) || text(row.catalogKey);
  const owner = experts.find(candidate => candidate.key === expertKey || candidate.catalogKey === expertKey || candidate.id === expertKey);
  const options = (Array.isArray(row.options) ? row.options : []).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const option = value as Record<string, unknown>;
    const optionId = text(option.id) || text(option.optionId);
    if (!optionId) return [];
    const base = number(option.baseMonths ?? option.base_period ?? row.baseMonths ?? row.base_period);
    const bonus = number(option.bonusMonths ?? option.bonus_period ?? row.bonusMonths ?? row.bonus_period);
    return [{
      ...option,
      id: optionId,
      base_period: base,
      bonus_period: bonus,
      totalMonths: number(option.totalMonths ?? option.total_months ?? option.months, base + bonus),
      price: number(option.amount ?? option.price ?? row.amount ?? row.price),
      amount: number(option.amount ?? option.price ?? row.amount ?? row.price),
      is_popular: option.is_popular === true || option.isPopular === true,
    }];
  });
  if (!id || !owner || options.length === 0) return null;
  return {
    ...row,
    id,
    product_name: text(row.title) || text(row.product_name) || text(row.name) || 'VIP 회원서비스',
    expert_id: owner.id,
    expert_key: owner.key,
    expert_name: owner.name,
    profile_image: owner.image,
    options,
  };
}

function registry(value: unknown): PublicRegistry {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const experts = Array.isArray(source.experts) ? source.experts.map(expert).filter((row): row is PublicRegistryExpert => row !== null) : [];
  const products = Array.isArray(source.products) ? source.products.map(row => product(row, experts)).filter((row): row is PublicRegistryProduct => row !== null) : [];
  return {
    experts: experts.filter(row => row.visible).sort((left, right) => left.order - right.order || left.name.localeCompare(right.name, 'ko-KR')),
    products: products.filter(row => row.display !== false),
  };
}

/** Public registry only: no customer-specific role or membership fields are requested or retained. */
export function usePublicRegistry() {
  const [value, setValue] = useState<PublicRegistry>(emptyRegistry);
  const [loading, setLoading] = useState(true);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    try {
      const response = await fetch('/api/registry', { cache: 'no-store', credentials: 'same-origin', signal: nextController.signal });
      const result = await readApiJson<unknown>(response);
      if (!response.ok) return;
      const next = registry(result);
      if (mounted.current) setValue(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        // Keep the last public response; an empty registry is intentionally the initial UI state.
      }
    } finally {
      if (mounted.current && controller.current === nextController) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const onFocus = () => { void refresh(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  return useMemo(() => ({ registry: value, loading, refresh }), [value, loading, refresh]);
}

export default usePublicRegistry;
