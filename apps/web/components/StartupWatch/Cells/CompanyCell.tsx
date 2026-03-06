import React from 'react';
export default function CompanyCell({ name, domain }: { name: string; domain?: string }) {
  return <div><div className="font-medium">{name}</div>{domain && <div className="text-xs text-gray-500">{domain}</div>}</div>;
}
