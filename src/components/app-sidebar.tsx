import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
} from '@/components/ui/sidebar';
import { Variable } from '@/types/variable';
import { VariableCard } from './variable-card';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useCommunication } from '@/hooks/useCommunication';
import {
  VariableChangeProvider,
  useVariableChangeContext,
} from '@/contexts/VariableChangeContext';
import { ScrollArea } from '@/components/ui/scroll-area';

function AppSidebarContent() {
  const { pool, isConnected } = useCommunication();
  const [variables, setVariables] = useState<Variable[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const { notifyChange } = useVariableChangeContext();

  const updateVariablesList = useCallback(() => {
    const variablesList: Variable[] = [];

    pool.forEach((variable, id) => {
      variablesList.push({
        id,
        serialVariable: { value: variable },
        isEnabled: true,
        color: 'blue',
      });
    });

    setVariables(variablesList);
  }, [pool]);

  const memoizedVariables = useMemo(() => {
    const variablesList = variables.map((variable) => ({
      ...variable,
      serialVariable: {
        value: variable.serialVariable.value,
      },
    }));

    if (!searchQuery.trim()) {
      return variablesList;
    }

    return variablesList.filter((variable) => {
      const variableName = variable.serialVariable.value.getName();
      return variableName.toLowerCase().includes(searchQuery.toLowerCase());
    });
  }, [variables, searchQuery]);

  /**
   * Add a listener to the variable pool and poll for updates.
   */
  useEffect(() => {
    const handleVariableChange = (id: number) => {
      notifyChange(id);

      const currentVariableCount = pool.getVariableCount();
      if (currentVariableCount !== variables.length) {
        updateVariablesList();
      }
    };

    pool.addVariableChangeListener(handleVariableChange);

    if (isConnected && variables.length === 0) {
      const checkPoolTimer = setInterval(() => {
        if (pool.getVariableCount() > 0) {
          updateVariablesList();
          clearInterval(checkPoolTimer);
        }
      }, 250);
      return () => clearInterval(checkPoolTimer);
    }
  }, [isConnected, pool, updateVariablesList, variables.length, notifyChange]);

  /**
   * Update the variables list whenever there are new variables in the pool.
   */
  useEffect(() => {
    if (pool.getVariableCount() > 0 && variables.length === 0) {
      updateVariablesList();
    }
  }, [pool, updateVariablesList, variables.length]);

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="border-b">
        <h2 className="text-lg font-semibold px-2">Micras Monitor</h2>
        <div className="px-2">
          <SidebarInput
            placeholder="Search variables..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="mt-2"
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <ScrollArea className="h-full w-full">
          <SidebarGroup className="px-4">
            <SidebarGroupLabel>
              Variables
              {searchQuery.trim() && (
                <span className="ml-2 text-xs text-muted-foreground">
                  ({memoizedVariables.length} of {variables.length})
                </span>
              )}
            </SidebarGroupLabel>
            <SidebarGroupContent className="space-y-2">
              {memoizedVariables.length > 0 ? (
                memoizedVariables.map((variable) => (
                  <VariableCard key={variable.id} variable={variable} />
                ))
              ) : searchQuery.trim() ? (
                <div className="text-sm text-muted-foreground text-center py-4">
                  No variables found matching "{searchQuery}"
                </div>
              ) : (
                <div className="text-sm text-muted-foreground text-center py-4">
                  No variables available
                </div>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </ScrollArea>
      </SidebarContent>
    </Sidebar>
  );
}

export function AppSidebar() {
  return (
    <VariableChangeProvider>
      <AppSidebarContent />
    </VariableChangeProvider>
  );
}
