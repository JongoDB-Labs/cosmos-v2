-- A document may now belong to the firm rather than to a project. The firm-wide
-- file library holds the things that outlive any one job -- templates, standard
-- details, certificates of insurance -- and those have no project to hang on.
-- Existing rows all carry a project and are untouched.
ALTER TABLE "documents" ALTER COLUMN "project_id" DROP NOT NULL;
