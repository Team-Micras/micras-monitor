import React, { useState, useEffect, useCallback } from 'react';
import { useCommunication } from '../contexts/CommunicationContext';
import { ISerialVariable } from '../lib/comm/variables/ISerialVariable';

interface VariableItem {
  id: number;
  name: string;
  type: string;
  value: string;
  readOnly: boolean;
}

// Type ranges based on C++ types
const TYPE_RANGES: Record<string, { min: number; max: number }> = {
  bool: { min: 0, max: 1 },
  char: { min: 0, max: 255 },
  "unsigned char": { min: 0, max: 255 },
  "signed char": { min: -128, max: 127 },
  "short unsigned int": { min: 0, max: 65535 },
  "short int": { min: -32768, max: 32767 },
  "unsigned int": { min: 0, max: 4294967295 },
  int: { min: -2147483648, max: 2147483647 },
  "long unsigned int": { min: 0, max: Number.MAX_SAFE_INTEGER },
  "long int": { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER },
  float: { min: -3.4e38, max: 3.4e38 },
  double: { min: -1.7e308, max: 1.7e308 },
};

// Slider ranges - more practical ranges for UI sliders
const SLIDER_RANGES: Record<string, { min: number; max: number; step: number }> = {
  bool: { min: 0, max: 1, step: 1 },
  char: { min: 0, max: 255, step: 1 },
  "unsigned char": { min: 0, max: 255, step: 1 },
  "signed char": { min: -128, max: 127, step: 1 },
  "short unsigned int": { min: 0, max: 1000, step: 1 }, // Practical range for slider
  "short int": { min: -1000, max: 1000, step: 1 }, // Practical range for slider
  "unsigned int": { min: 0, max: 1000, step: 1 }, // Practical range for slider
  int: { min: -1000, max: 1000, step: 1 }, // Practical range for slider
  "long unsigned int": { min: 0, max: 1000, step: 1 }, // Practical range for slider
  "long int": { min: -1000, max: 1000, step: 1 }, // Practical range for slider
  float: { min: -100, max: 100, step: 0.1 }, // Practical range for slider
  double: { min: -100, max: 100, step: 0.1 }, // Practical range for slider
};

export const VariablesMonitor: React.FC = () => {
  const { pool, isConnected } = useCommunication();
  const [variables, setVariables] = useState<VariableItem[]>([]);
  const [refresh, setRefresh] = useState(false);
  const [lastVariableCount, setLastVariableCount] = useState(0);

  // Function to update the variables list from the pool
  const updateVariablesList = useCallback(() => {
    if (!pool) return;
    
    const variablesList: VariableItem[] = [];
    let currentCount = 0;
    
    pool.forEach((variable, id) => {
      currentCount++;
      variablesList.push({
        id,
        name: variable.getName(),
        type: variable.getType(),
        value: getValueDisplayString(variable),
        readOnly: variable.isReadOnly()
      });
    });
    
    // Always update the variables to ensure fresh data
    setVariables(variablesList);
    setLastVariableCount(currentCount);
  }, [pool]);

  // Poll for updates if connected but no variables yet
  useEffect(() => {
    if (isConnected && pool && variables.length === 0) {
      const checkPoolTimer = setInterval(() => {
        let count = 0;
        pool.forEach(() => count++);
        
        if (count > 0) {
          updateVariablesList();
          clearInterval(checkPoolTimer);
        }
      }, 250);
      
      return () => clearInterval(checkPoolTimer);
    }
  }, [isConnected, pool, variables.length, updateVariablesList]);

  // Update the variable list whenever there's a change in the pool, connection status, or a refresh is triggered
  useEffect(() => {
    updateVariablesList();
    
    // Add a listener for variable changes
    if (pool) {
      const handleVariableChange = () => {
        setRefresh(prev => !prev);
      };
      
      pool.addVariableChangeListener(handleVariableChange);
    }
  }, [pool, isConnected, updateVariablesList]);

  // Re-render when refresh state changes
  useEffect(() => {
    updateVariablesList();
  }, [refresh, updateVariablesList]);

  // Add a periodic refresh to keep values updated
  useEffect(() => {
    if (isConnected && pool && variables.length > 0) {
      const refreshTimer = setInterval(() => {
        updateVariablesList();
      }, 100); // Refresh 10 times per second for smoother updates
      
      return () => clearInterval(refreshTimer);
    }
  }, [isConnected, pool, variables.length, updateVariablesList]);

  // Get a string representation of a variable's value
  const getValueDisplayString = (variable: ISerialVariable): string => {
    if (!variable) return 'undefined';
    
    const valueRef = variable.getReference();
    const value = valueRef.value;
    
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    } else if (typeof value === 'number') {
      // Format numbers nicely with up to 3 decimal places
      return Number.isInteger(value) ? value.toString() : value.toFixed(3);
    } else if (typeof value === 'bigint') {
      return value.toString();
    } else if (typeof value === 'string') {
      return value;
    } else if (typeof value === 'object' && value !== null) {
      return '[Object]'; // We don't support custom objects in this version
    }
    
    return String(value);
  };

  // Handle value changes from the UI
  const handleValueChange = (id: number, newValue: any) => {
    if (!pool) return;
    
    const variable = pool.getVariable(id);
    if (!variable || variable.isReadOnly()) return;
    
    const type = variable.getType();
    
    try {
      console.log(`Updating variable ${variable.getName()} with ID ${id} from ${variable.getReference().value} to ${newValue}`);
      
      if (type === 'bool') {
        pool.updateVariable<boolean>(id, (ref) => {
          ref.value = newValue === 'true' || newValue === true;
        });
      } else if (type === 'int' || type === 'short int' || type === 'unsigned int' || type === 'short unsigned int') {
        pool.updateVariable<number>(id, (ref) => {
          ref.value = parseInt(newValue, 10);
        });
      } else if (type === 'float' || type === 'double') {
        pool.updateVariable<number>(id, (ref) => {
          ref.value = parseFloat(newValue);
        });
      } else if (type === 'char') {
        pool.updateVariable<string>(id, (ref) => {
          ref.value = String(newValue).charAt(0) || '';
        });
      } else if (type === 'long int' || type === 'long unsigned int') {
        pool.updateVariable<bigint>(id, (ref) => {
          ref.value = BigInt(newValue);
        });
      }
      
      console.log(`Variable ${variable.getName()} updated to ${variable.getReference().value}`);
      
      // Explicitly trigger a refresh to ensure UI update
      setRefresh(prev => !prev);
    } catch (error) {
      console.error(`Error updating variable ${variable.getName()}:`, error);
    }
  };

  // Get appropriate slider attributes based on variable type
  const getSliderAttributes = (type: string, currentValue: number) => {
    // Get the slider range configuration for this type
    const rangeConfig = SLIDER_RANGES[type] || { min: -100, max: 100, step: 1 };
    
    // Get the actual range limits for the type
    const actualRange = TYPE_RANGES[type] || { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };
    
    // If the current value is outside the slider range but within the actual range,
    // adjust the slider range to accommodate the value
    let { min, max, step } = rangeConfig;
    
    if (currentValue < min && currentValue >= actualRange.min) {
      min = Math.max(currentValue - Math.abs(currentValue * 0.5), actualRange.min);
    }
    
    if (currentValue > max && currentValue <= actualRange.max) {
      max = Math.min(currentValue + Math.abs(currentValue * 0.5), actualRange.max);
    }
    
    return { min, max, step };
  };

  // Render appropriate input control based on variable type
  const renderVariableControl = (variable: VariableItem) => {
    if (!pool) return null;
    
    const serialVar = pool.getVariable(variable.id);
    if (!serialVar) return null;
    
    // If the variable is read-only, just display its value
    if (serialVar.isReadOnly()) {
      return <div>{variable.value}</div>;
    }
    
    const valueRef = serialVar.getReference();
    // Get the direct value from the reference, not from the display string
    const value = valueRef.value;
    
    switch (variable.type) {
      case 'bool':
        return (
          <select 
            value={value.toString()}
            onChange={(e) => handleValueChange(variable.id, e.target.value)}
            className="control-select"
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        );
        
      case 'int':
      case 'short int':
      case 'unsigned int':
      case 'short unsigned int':
      case 'long int':
      case 'long unsigned int':
      case 'signed char':
      case 'unsigned char': {
        const numValue = Number(value);
        const { min, max, step } = getSliderAttributes(variable.type, numValue);
        return (
          <div className="control-numeric">
            <input 
              type="number"
              value={numValue}
              onChange={(e) => handleValueChange(variable.id, e.target.value)}
              className="control-input"
            />
            <input 
              type="range" 
              min={min}
              max={max}
              step={step}
              value={numValue}
              onChange={(e) => handleValueChange(variable.id, e.target.value)}
              onInput={(e) => handleValueChange(variable.id, (e.target as HTMLInputElement).value)}
              className="control-slider"
            />
            <small className="range-info">{min} to {max}</small>
          </div>
        );
      }
        
      case 'float':
      case 'double': {
        const numValue = Number(value);
        const { min, max, step } = getSliderAttributes(variable.type, numValue);
        return (
          <div className="control-numeric">
            <input 
              type="number" 
              step={step}
              value={numValue}
              onChange={(e) => handleValueChange(variable.id, e.target.value)}
              className="control-input"
            />
            <input 
              type="range" 
              min={min}
              max={max}
              step={step}
              value={numValue}
              onChange={(e) => handleValueChange(variable.id, e.target.value)}
              onInput={(e) => handleValueChange(variable.id, (e.target as HTMLInputElement).value)}
              className="control-slider"
            />
            <small className="range-info">{min} to {max}</small>
          </div>
        );
      }
        
      case 'char':
        return (
          <input 
            type="text" 
            maxLength={1}
            value={String(value)}
            onChange={(e) => handleValueChange(variable.id, e.target.value)}
            className="control-input"
          />
        );
        
      default:
        return <div>{variable.value}</div>;
    }
  };

  return (
    <div className="variables-monitor">
      <h2>Serial Variables</h2>
      
      {!isConnected && (
        <div className="no-connection-message">
          <p>Connect to a device to view variables</p>
        </div>
      )}
      
      {isConnected && variables.length === 0 && (
        <div className="no-variables-message">
          <p>Waiting for variables from the device...</p>
        </div>
      )}
      
      {variables.length > 0 && (
        <div className="variables-table-container">
          <table className="variables-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Type</th>
                <th>Value</th>
                <th>Control</th>
              </tr>
            </thead>
            <tbody>
              {variables.map((variable) => (
                <tr key={variable.id} className={variable.readOnly ? 'read-only' : ''}>
                  <td>{variable.id}</td>
                  <td>{variable.name}</td>
                  <td>{variable.type}</td>
                  <td>{variable.value}</td>
                  <td>{renderVariableControl(variable)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};