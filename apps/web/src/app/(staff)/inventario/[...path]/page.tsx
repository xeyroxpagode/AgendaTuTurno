import { Suspense } from "react";
import { notFound } from "next/navigation";
import { InventoryWorkspace } from "@/features/inventory/InventoryWorkspace";
export default async function InventoryDeepLink({params}:{params:Promise<{path:string[]}>}){
  const {path}=await params;
  const views={articulos:'CATALOG',movimientos:'HISTORY',ubicaciones:'LOCATIONS',conteos:'COUNTS',minimos:'ROOT'} as const;
  const view=views[path[0] as keyof typeof views];if(!view||path.length>2)notFound();
  const create=path[0]==='articulos'&&path[1]==='nuevo';
  const itemId=path[0]==='articulos'&&path[1]&&!create?path[1]:undefined;
  if(path.length===2&&!create&&!itemId)notFound();
  if(itemId&&!/^[0-9a-f-]{36}$/i.test(itemId))notFound();
  return <Suspense fallback={<p role="status">Cargando inventario…</p>}><InventoryWorkspace initialView={view} initialCreate={create} initialItemId={itemId}/></Suspense>;
}
