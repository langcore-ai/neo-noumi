-- 同一用户的活跃 project 名称必须唯一，避免 /workspace/{projectName} 挂载串用。
WITH RECURSIVE duplicate_active_projects AS (
    SELECT
        "id",
        "userId",
        "name",
        row_number() OVER (
            PARTITION BY "userId", "name"
            ORDER BY "createdAt" ASC, "id" ASC
        ) AS duplicate_index
    FROM "projects"
    WHERE "deletedAt" IS NULL
),
candidate_names AS (
    SELECT
        "id",
        "userId",
        "name" || ' (' || "id" || ')' AS candidate_name,
        0 AS attempt
    FROM duplicate_active_projects
    WHERE duplicate_index > 1

    UNION ALL

    SELECT
        candidate."id",
        candidate."userId",
        candidate.candidate_name || ' duplicate',
        candidate.attempt + 1
    FROM candidate_names AS candidate
    WHERE EXISTS (
          SELECT 1
          FROM "projects" AS project
          WHERE project."userId" = candidate."userId"
            AND project."deletedAt" IS NULL
            AND project."id" <> candidate."id"
            AND project."name" = candidate.candidate_name
      )
),
available_names AS (
    SELECT DISTINCT ON (candidate."id")
        candidate."id",
        candidate.candidate_name
    FROM candidate_names AS candidate
    WHERE NOT EXISTS (
        SELECT 1
        FROM "projects" AS project
        WHERE project."userId" = candidate."userId"
          AND project."deletedAt" IS NULL
          AND project."id" <> candidate."id"
          AND project."name" = candidate.candidate_name
    )
    ORDER BY candidate."id", candidate.attempt ASC
)
UPDATE "projects" AS project
SET "name" = available.candidate_name
FROM available_names AS available
WHERE project."id" = available."id";

-- Prisma 目前不能表达 partial unique index，这里用原生 PostgreSQL 索引约束软删除后的活跃项目。
CREATE UNIQUE INDEX "projects_userId_name_active_unique"
ON "projects"("userId", "name")
WHERE "deletedAt" IS NULL;
