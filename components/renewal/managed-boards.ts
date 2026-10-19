export interface ManagedArticle {
  id: string; title: string; date: string; category?: string; content?: string; body?: string;
  expert?: string; expertName?: string; href?: string; locked: boolean; pinned?: boolean;
  faqCategory?: string; titleStyle?: { color?: string; fontSize?: number; fontWeight?: number };
}
export interface ManagedEvent extends ManagedArticle {
  detailTitle?: string; detailDate?: string; detailImage?: string; cardImage?: string;
  tag?: string; status?: string; tone?: string; description?: string; action?: string;
}
export interface ManagedBoards {
  free: { posts: ManagedArticle[]; notices: ManagedArticle[] };
  notice: ManagedArticle[]; faq: ManagedArticle[]; event: ManagedEvent[];
}
export const emptyManagedBoards = (): ManagedBoards => ({ free: { posts: [], notices: [] }, notice: [], faq: [], event: [] });
