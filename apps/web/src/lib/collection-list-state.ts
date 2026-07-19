import type { CollectionSchema } from "@samurai-agent/core-schemas";
import { ApiError } from "./api";

export function collectionSchemaTitle(schema: CollectionSchema): string { return schema.labels?.ja ?? schema.labels?.en ?? schema.id; }
export function collectionSchemaRenderer(schema: CollectionSchema): string { return String((schema.views ?? []).find((view) => typeof view.renderer === "string")?.renderer ?? "collection_table"); }
export function collectionDefaultViewId(schema: CollectionSchema): string {
  const firstView = (schema.views ?? [])[0];
  return typeof firstView?.id === "string" && firstView.id ? firstView.id : `${schema.id}_table`;
}
export function collectionListErrorMessage(error: unknown): string {
  return error instanceof ApiError ? `Collection一覧を読み込めませんでした。APIエラー ${error.status}` : "Collection一覧を読み込めませんでした。API接続を確認してください。";
}
