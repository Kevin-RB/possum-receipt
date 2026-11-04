import {
  boolean,
  index,
  snakeCase,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const user = snakeCase.table("user", {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  id: text().primaryKey(),
  image: text(),
  inviteCode: text(),
  name: text().notNull(),
  // Where the account was created, captured at sign-up. Nullable: Better Auth
  // writes it, but a row created before this column existed has no zone, and
  // `resolveTimezone` treats that the same as one it cannot read.
  timezone: text(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const session = snakeCase.table(
  "session",
  {
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    id: text().primaryKey(),
    ipAddress: text(),
    token: text().notNull().unique(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdate(() => new Date()),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_index").on(table.userId)]
);

export const account = snakeCase.table(
  "account",
  {
    accessToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    accountId: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    id: text().primaryKey(),
    idToken: text(),
    password: text(),
    providerId: text().notNull(),
    refreshToken: text(),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdate(() => new Date()),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("account_user_id_index").on(table.userId)]
);

export const verification = snakeCase.table(
  "verification",
  {
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    id: text().primaryKey(),
    identifier: text().notNull(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    value: text().notNull(),
  },
  (table) => [index("verification_identifier_index").on(table.identifier)]
);
