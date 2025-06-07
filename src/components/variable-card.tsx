import type { Variable } from '@/types/variable';
import { Card, CardContent } from '@/components/ui/card';
import { Circle } from 'lucide-react';
import { memo } from 'react';
import { useVariableValue } from '@/hooks/useVariableValue';

interface VariableCardProps {
  variable: Variable;
}

export const VariableCard = memo(
  function VariableCard({ variable }: VariableCardProps) {
    const serialVariableRef = variable.serialVariable.value;
    const { value, name, type } = useVariableValue(serialVariableRef, variable.id);

    const formatValue = (val: unknown): string => {
      if (typeof val === 'number' && !Number.isInteger(val)) {
        return val.toFixed(3);
      }
      return String(val);
    };

    const cropName = (name: string) =>
      name.length > 21 ? name.slice(0, 21) + '...' : name;

    return (
      <Card className="cursor-move transition-opacity hover:shadow-md">
        <CardContent className="p-3">
          <div className="flex flex-col h-full">
            <div className="flex justify-between items-start">
              <h3 className="font-medium text-sm">{cropName(name)}</h3>
              <span className="text-xs text-muted-foreground">{formatValue(value)}</span>
            </div>

            <div className="flex justify-between items-end mt-auto pt-2">
              <span className="text-xs text-muted-foreground">{type}</span>
              {
                <Circle
                  className="h-3 w-3 fill-current"
                  style={{ color: variable.color || 'gray' }}
                />
              }
            </div>
          </div>
        </CardContent>
      </Card>
    );
  },
  (prevProps, nextProps) => {
    return (
      prevProps.variable.id === nextProps.variable.id &&
      prevProps.variable.isEnabled === nextProps.variable.isEnabled &&
      prevProps.variable.color === nextProps.variable.color
    );
  }
);
