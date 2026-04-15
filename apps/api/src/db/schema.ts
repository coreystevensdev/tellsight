import {
  pgTable,
  pgEnum,
  integer,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  numeric,
  date,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const userRoleEnum = pgEnum('user_role', ['owner', 'member']);

export const users = pgTable('users', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  email: varchar({ length: 255 }).notNull().unique(),
  name: varchar({ length: 255 }).notNull(),
  googleId: varchar('google_id', { length: 255 }).unique(),
  avatarUrl: text('avatar_url'),
  isPlatformAdmin: boolean('is_platform_admin').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const orgs = pgTable('orgs', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: varchar({ length: 255 }).notNull(),
  slug: varchar({ length: 255 }).notNull().unique(),
  businessProfile: jsonb('business_profile'),
  // Circular FK with datasets — constraint lives in the migration, not here
  activeDatasetId: integer('active_dataset_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const userOrgs = pgTable(
  'user_orgs',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: integer('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    role: userRoleEnum('role').default('member').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('user_orgs_unique_user_org').on(table.userId, table.orgId),
    index('idx_user_orgs_user_id').on(table.userId),
    index('idx_user_orgs_org_id').on(table.orgId),
  ],
);

export const orgInvites = pgTable(
  'org_invites',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    orgId: integer('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 255 }).notNull().unique(),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedBy: integer('used_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_org_invites_org_id').on(table.orgId),
    index('idx_org_invites_token_hash').on(table.tokenHash),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    tokenHash: varchar('token_hash', { length: 255 }).notNull().unique(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: integer('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_refresh_tokens_user_id').on(table.userId)],
);

export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    orgId: integer('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventName: varchar('event_name', { length: 100 }).notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_analytics_events_org_id').on(table.orgId),
    index('idx_analytics_events_event_name').on(table.eventName),
    index('idx_analytics_events_created_at').on(table.createdAt),
    index('idx_analytics_events_ai_usage').on(table.orgId, table.eventName, table.createdAt),
  ],
);

export const sourceTypeEnum = pgEnum('source_type', [
  'csv',
  'quickbooks',
  'xero',
  'stripe',
  'plaid',
]);

export const datasets = pgTable(
  'datasets',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    orgId: integer('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: varchar({ length: 255 }).notNull(),
    sourceType: sourceTypeEnum('source_type').default('csv').notNull(),
    isSeedData: boolean('is_seed_data').default(false).notNull(),
    uploadedBy: integer('uploaded_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index('idx_datasets_org_id').on(table.orgId)],
);

export const dataRows = pgTable(
  'data_rows',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    orgId: integer('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    datasetId: integer('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    sourceType: sourceTypeEnum('source_type').default('csv').notNull(),
    sourceId: varchar('source_id', { length: 255 }),
    category: varchar({ length: 255 }).notNull(),
    parentCategory: varchar('parent_category', { length: 255 }),
    date: date('date', { mode: 'date' }).notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    label: varchar({ length: 255 }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_data_rows_org_id_date').on(table.orgId, table.date),
    index('idx_data_rows_dataset_id').on(table.datasetId),
    index('idx_data_rows_category').on(table.category),
    uniqueIndex('idx_data_rows_source_id')
      .on(table.orgId, table.sourceId)
      .where(sql`${table.sourceId} IS NOT NULL`),
  ],
);

export const aiSummaries = pgTable(
  'ai_summaries',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    orgId: integer('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    datasetId: integer('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    transparencyMetadata: jsonb('transparency_metadata').notNull().default('{}'),
    promptVersion: varchar('prompt_version', { length: 20 }).notNull(),
    isSeed: boolean('is_seed').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    staleAt: timestamp('stale_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_ai_summaries_org_dataset').on(table.orgId, table.datasetId),
  ],
);

export const shares = pgTable(
  'shares',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    orgId: integer('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    datasetId: integer('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 255 }).notNull().unique(),
    insightSnapshot: jsonb('insight_snapshot').notNull(),
    chartSnapshotUrl: varchar('chart_snapshot_url', { length: 2048 }),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    viewCount: integer('view_count').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_shares_org_id').on(table.orgId),
    uniqueIndex('idx_shares_token_hash').on(table.tokenHash),
  ],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    orgId: integer('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
    stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
    status: varchar({ length: 50 }).notNull().default('inactive'),
    plan: varchar({ length: 50 }).notNull().default('free'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_subscriptions_org_id_unique').on(table.orgId),
    uniqueIndex('idx_subscriptions_stripe_sub_id')
      .on(table.stripeSubscriptionId)
      .where(sql`${table.stripeSubscriptionId} is not null`),
  ],
);

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    orgId: integer('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    provider: varchar({ length: 50 }).notNull(),
    providerTenantId: varchar('provider_tenant_id', { length: 255 }).notNull(),
    encryptedRefreshToken: text('encrypted_refresh_token').notNull(),
    encryptedAccessToken: text('encrypted_access_token').notNull(),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }).notNull(),
    scope: varchar({ length: 500 }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    syncStatus: varchar('sync_status', { length: 20 }).notNull().default('idle'),
    syncError: text('sync_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_integration_connections_org_provider').on(table.orgId, table.provider),
  ],
);

export const syncJobs = pgTable(
  'sync_jobs',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    orgId: integer('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    connectionId: integer('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    trigger: varchar({ length: 20 }).notNull(),
    status: varchar({ length: 20 }).notNull().default('queued'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    rowsSynced: integer('rows_synced').notNull().default(0),
    error: text(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_sync_jobs_connection_id').on(table.connectionId),
    index('idx_sync_jobs_org_id').on(table.orgId),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  userOrgs: many(userOrgs),
  refreshTokens: many(refreshTokens),
  createdInvites: many(orgInvites, { relationName: 'inviteCreator' }),
  createdShares: many(shares, { relationName: 'shareCreator' }),
  analyticsEvents: many(analyticsEvents),
  uploadedDatasets: many(datasets, { relationName: 'datasetUploader' }),
}));

export const orgsRelations = relations(orgs, ({ many, one }) => ({
  userOrgs: many(userOrgs),
  refreshTokens: many(refreshTokens),
  invites: many(orgInvites),
  shares: many(shares),
  analyticsEvents: many(analyticsEvents),
  datasets: many(datasets),
  aiSummaries: many(aiSummaries),
  subscription: one(subscriptions),
  integrationConnections: many(integrationConnections),
  activeDataset: one(datasets, {
    fields: [orgs.activeDatasetId],
    references: [datasets.id],
  }),
}));

export const userOrgsRelations = relations(userOrgs, ({ one }) => ({
  user: one(users, {
    fields: [userOrgs.userId],
    references: [users.id],
  }),
  org: one(orgs, {
    fields: [userOrgs.orgId],
    references: [orgs.id],
  }),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, {
    fields: [refreshTokens.userId],
    references: [users.id],
  }),
  org: one(orgs, {
    fields: [refreshTokens.orgId],
    references: [orgs.id],
  }),
}));

export const orgInvitesRelations = relations(orgInvites, ({ one }) => ({
  org: one(orgs, {
    fields: [orgInvites.orgId],
    references: [orgs.id],
  }),
  creator: one(users, {
    fields: [orgInvites.createdBy],
    references: [users.id],
    relationName: 'inviteCreator',
  }),
}));

export const analyticsEventsRelations = relations(analyticsEvents, ({ one }) => ({
  org: one(orgs, {
    fields: [analyticsEvents.orgId],
    references: [orgs.id],
  }),
  user: one(users, {
    fields: [analyticsEvents.userId],
    references: [users.id],
  }),
}));

export const datasetsRelations = relations(datasets, ({ one, many }) => ({
  org: one(orgs, {
    fields: [datasets.orgId],
    references: [orgs.id],
  }),
  uploader: one(users, {
    fields: [datasets.uploadedBy],
    references: [users.id],
    relationName: 'datasetUploader',
  }),
  rows: many(dataRows),
  aiSummaries: many(aiSummaries),
  shares: many(shares),
}));

export const dataRowsRelations = relations(dataRows, ({ one }) => ({
  dataset: one(datasets, {
    fields: [dataRows.datasetId],
    references: [datasets.id],
  }),
  org: one(orgs, {
    fields: [dataRows.orgId],
    references: [orgs.id],
  }),
}));

export const aiSummariesRelations = relations(aiSummaries, ({ one }) => ({
  org: one(orgs, {
    fields: [aiSummaries.orgId],
    references: [orgs.id],
  }),
  dataset: one(datasets, {
    fields: [aiSummaries.datasetId],
    references: [datasets.id],
  }),
}));

export const sharesRelations = relations(shares, ({ one }) => ({
  org: one(orgs, {
    fields: [shares.orgId],
    references: [orgs.id],
  }),
  dataset: one(datasets, {
    fields: [shares.datasetId],
    references: [datasets.id],
  }),
  creator: one(users, {
    fields: [shares.createdBy],
    references: [users.id],
    relationName: 'shareCreator',
  }),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  org: one(orgs, {
    fields: [subscriptions.orgId],
    references: [orgs.id],
  }),
}));

export const integrationConnectionsRelations = relations(integrationConnections, ({ one, many }) => ({
  org: one(orgs, {
    fields: [integrationConnections.orgId],
    references: [orgs.id],
  }),
  syncJobs: many(syncJobs),
}));

export const syncJobsRelations = relations(syncJobs, ({ one }) => ({
  org: one(orgs, {
    fields: [syncJobs.orgId],
    references: [orgs.id],
  }),
  connection: one(integrationConnections, {
    fields: [syncJobs.connectionId],
    references: [integrationConnections.id],
  }),
}));
