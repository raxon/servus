import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(), name: text('name').notNull(), description: text('description').notNull(),
  createdAt: text('created_at').notNull(),
  deletedAt: text('deleted_at'),displayName:text('display_name'),
});
export const services = sqliteTable('services', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull().references(() => projects.id),
  name: text('name').notNull(), image: text('image').notNull(), port: integer('port').notNull(),
  hostname: text('hostname').notNull(), replicas: integer('replicas').notNull(), revision: integer('revision').notNull(),
  deployedRevision: integer('deployed_revision'), state: text('state').notNull(), lastError: text('last_error'),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
  config:text('config').notNull().default('{}'),deletedAt:text('deleted_at'),displayName:text('display_name'),displayHostname:text('display_hostname'),sourceCommit:text('source_commit'),imageDigest:text('image_digest'),
});
export const actions = sqliteTable('actions', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull().references(() => projects.id),
  serviceId: text('service_id').notNull().references(() => services.id), type: text('type').notNull(),
  status: text('status').notNull(), phase: text('phase').notNull(), error: text('error'),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(), finishedAt: text('finished_at'),
});
