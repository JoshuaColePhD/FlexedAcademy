import sys

# 1. Update routes/classes.py
file_path = "backend/routes/classes.py"
with open(file_path, "r") as f:
    content = f.read()

content = content.replace(
    "def list_classes_route(user_id: str = Depends(get_current_user)) -> list[dict]:\n    return db.list_classes(user_id)",
    "def list_classes_route(include_archived: bool = False, user_id: str = Depends(get_current_user)) -> list[dict]:\n    return db.list_classes(user_id, include_archived)"
)

with open(file_path, "w") as f:
    f.write(content)

# 2. Update frontend/src/lib/api.js
file_path = "frontend/src/lib/api.js"
with open(file_path, "r") as f:
    content = f.read()

content = content.replace(
    "listClasses: ({ signal } = {}) => request('/api/classes', { signal }),",
    "listClasses: ({ include_archived, signal } = {}) => request(`/api/classes${include_archived ? '?include_archived=true' : ''}`, { signal }),"
)

with open(file_path, "w") as f:
    f.write(content)

# 3. Update frontend/src/hooks/useAppData.js
file_path = "frontend/src/hooks/useAppData.js"
with open(file_path, "r") as f:
    content = f.read()

content = content.replace(
    "export function useClasses() {\n  return useQuery({\n    queryKey: qk.classes,\n    queryFn: () => api.listClasses(),",
    "export function useClasses(includeArchived = false) {\n  return useQuery({\n    queryKey: [...qk.classes, { includeArchived }],\n    queryFn: () => api.listClasses({ include_archived: includeArchived }),"
)

content = content.replace(
    "export function useActiveClass() {\n  const { classId } = useParams()\n  const { data: classes = [], isLoading } = useClasses()",
    "export function useActiveClass() {\n  const { classId } = useParams()\n  const { data: classes = [], isLoading } = useClasses(true) // Fetch all classes so direct links to archived classes still work"
)

with open(file_path, "w") as f:
    f.write(content)

print("Updated backend routes and frontend hooks to support include_archived.")
