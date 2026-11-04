# دليل الاستعادة (Restore)

استخدم الدليل ده لو مشروع Supabase اتمسح أو بقى بايظ. اتبع الخطوات بالترتيب. متقفزش خطوة.

التفاصيل التقنية في [BACKUP.md](BACKUP.md).

## قبل ما تبدأ

- الاستعادة بتروح في مشروع **فاضي** بس. لو فيه جداول `app` أو `ledger_scratch` السكريبت هيرفض. ده طبيعي ومقصود.
- متحاولش تستعيد في المشروع الشغال. اعمل مشروع جديد.
- كل الأوامر في Git Bash على الكمبيوتر بتاعك.

## 1. جهّز الأدوات

1. ثبّت Node 22.
2. ثبّت أدوات PostgreSQL نسخة 17 (`psql` و`pg_dump` و`pg_restore`). لازم النسخة 17 بالظبط.
3. نزّل الكود: `git clone` للريبو العام `thesharkapp`.
4. في Git Bash قول للسكريبت مكان الأدوات:

```
export BACKUP_PG_BIN="/c/Program Files/PostgreSQL/17/bin"
```

## 2. هات آخر نسخة سليمة

1. افتح الريبو الخاص `thesharkapp-backups`.
2. نزّل أحدث نسخة `backup-...tar.gz` ومعاها ملف `.sha256`. حطهم في نفس الفولدر.
3. افتح آخر تشغيل ناجح وتأكد إنه أخضر.

## 3. اعمل مشروع Supabase جديد فاضي

1. من الـ Dashboard اعمل مشروع جديد. اختار نفس الـ region لو تقدر.
2. متشغلش أي migration عليه.
3. من Authentication: اقفل التسجيل (Signups disabled).
4. من Settings، Data API: ضيف السكيمة `app` في Exposed schemas.
5. من Authentication، Users: اعمل مستخدم المالك (Add user) بالإيميل بتاعك. انسخ الـ UUID بتاعه.

## 4. حط بيانات الاتصال بالمشروع الجديد

من Dashboard، Connect، خد بيانات الـ **Session pooler**. بعد كده في Git Bash:

```
export PGHOST="<host>"
export PGPORT=5432
export PGUSER="postgres.<project ref>"
export PGDATABASE=postgres
export PGSSLMODE=verify-full
export BACKUP_RESTORE_CONFIRM=RESTORE-INTO-EMPTY-PROJECT
read -rs PGPASSWORD; export PGPASSWORD
```

- اكتب الباسورد بعد أمر `read` واضغط Enter. مش هيظهر على الشاشة.
- متكتبش الباسورد في أي ملف ولا في الشات.
- لو الاتصال فشل بسبب الشهادة، نزّل شهادة الـ CA من الـ Dashboard وحط مسارها: `export PGSSLROOTCERT="<path>"`.

## 5. شغّل الاستعادة

```
bash scripts/backup/restore.sh <مسار النسخة>.tar.gz remap <UUID المالك>
```

- لو UUID المالك القديم موجود في المشروع الجديد، ممكن تستخدم `preserve` بدل `remap <UUID>`.
- استنى لحد ما تشوف السطر: `restore complete`.
- السكريبت بيقارن كل جدول وكل دالة بالنسخة. لو فيه فرق بيقول اسمه ويقف.

## 6. لو فشلت الاستعادة

1. اقرا سطر `backup: error [CODE]` وافهم السبب. الأكواد في BACKUP.md.
2. لو الخطأ حصل بعد ما الاستعادة بدأت، المشروع فيه نسخة ناقصة. امسحها:

```
psql -c "drop schema if exists app, ledger_scratch cascade"
```

3. صلّح السبب وشغّل الخطوة 5 من الأول.
4. لو الأمر `TARGET_NOT_EMPTY` ظهر من الأول: ده مشروع مش فاضي. اعمل مشروع جديد.
5. متعدّلش السكريبت عشان يعدّي. لو محتار، وقف واسأل.

## 7. أصلح سجل الـ migrations

المشروع الجديد مفيهوش سجل migrations. من غير الإصلاح، أول `db push` هيحاول يشغل كل حاجة تاني.

1. فك النسخة وهات ملف `manifest.json`:

```
tar -xzf <النسخة>.tar.gz manifest.json
```

2. اربط المشروع وعلّم الإصدارات إنها اتطبقت:

```
supabase link --project-ref <project ref>
supabase migration repair --status applied $(node -p "require('./manifest.json').metadata.migrations.join(' ')")
supabase migration list
```

3. لازم القايمة تبين إن المحلي والبعيد زي بعض.

## 8. أنشئ مستخدم النسخ الاحتياطي من جديد

1. شغّل ملف `scripts/backup/provision-backup-reader.sql` في SQL editor.
2. حط الباسورد من جهازك:

```
psql "host=<host> port=5432 dbname=postgres user=postgres.<project ref> sslmode=verify-full"
\password backup_reader
```

3. حدّث السيكرتس الثلاثة في الريبو الخاص: `BACKUP_PGHOST` و`BACKUP_PGUSER` و`BACKUP_PGPASSWORD`.

## 9. حدّث التطبيق وجرّبه

1. حدّث `apps/web/.env.production` بالـ URL والـ publishable key الجديدين.
2. افتح التطبيق وسجل دخول بحساب المالك.
3. شوف المخزون، وجرّب شراء، وشوف شهر المصروفات.
4. لو حاجة مش مظبوطة، متكتبش بيانات جديدة. وقف واسأل.

## تمرين الاستعادة (مرة واحدة قبل ما تعتمد على النسخ)

1. استنى 3 أيام خضرا من النسخ اليومي.
2. اعمل مشروع Supabase مجاني تاني مؤقت.
3. اتبع الخطوات من 1 لـ 5 عليه.
4. افتح التطبيق على المشروع المؤقت وجرّب الدخول.
5. امسح المشروع المؤقت بس بعد موافقتك.
