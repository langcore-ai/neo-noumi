-- 用户 ID 会进入用户级 sandbox hostname，必须保持数字和小写字母。
ALTER TABLE "user"
	ADD CONSTRAINT "user_id_lower_alnum_check"
	CHECK ("id" ~ '^[0-9a-z]+$');
